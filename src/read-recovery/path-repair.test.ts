import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildReadPathRequest,
  planReadPathRepair,
  runReadPathSelection,
  selectReadPath,
  validateReadPathSelection,
} from "./path-repair.ts";
import { createReadPathState, recordReadPathRepair, recordReadPathSelection, summarizeReadPathState } from "./state.ts";
import type { JevClient, JevSelectionResponse } from "../infra/typesafe.ts";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "welder-readrepair-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seed(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
}

function scriptedClient(responses: JevSelectionResponse[]): { client: JevClient; calls: () => number } {
  let index = 0;
  let calls = 0;
  return {
    calls: () => calls,
    client: {
      async choose() {
        calls++;
        return responses[Math.min(index++, responses.length - 1)]!;
      },
    },
  };
}

test("plans eligible repairs with only relative paths in the Jev request", async () => {
  await withRoot(async (root) => {
    await seed(root, { "src/config.ts": "SECRET-CONTENT-A", "src/config.json": "SECRET-CONTENT-B" });

    const plan = await planReadPathRepair({ toolInput: { path: "src/confg.ts" }, cwd: root });
    assert.ok(plan);
    assert.equal(plan.requestedPath, "src/confg.ts");

    const request = buildReadPathRequest(plan);
    assert.equal(request.requestedEditText, "src/confg.ts");
    assert.ok(request.candidates.length > 0 && request.candidates.length <= 5);
    for (const candidate of request.candidates) {
      assert.equal(candidate.window, plan.candidates.find((entry) => entry.ordinal === candidate.ordinal)!.path);
      assert.ok(!path.isAbsolute(candidate.window));
      assert.ok(!candidate.window.includes(".."));
    }
    // No file contents, no absolute paths, no conversation payload.
    const serialized = JSON.stringify(request);
    assert.equal(serialized.includes(root), false);
    assert.equal(serialized.includes("SECRET-CONTENT"), false);
  });
});

test("planning fails closed for non-read inputs, existing files, directories, and escapes", async () => {
  await withRoot(async (root) => {
    await seed(root, { "src/config.ts": "x" });

    assert.equal(await planReadPathRepair({ toolInput: {}, cwd: root }), undefined);
    assert.equal(await planReadPathRepair({ toolInput: { path: 42 }, cwd: root }), undefined);
    assert.equal(await planReadPathRepair({ toolInput: { path: "src/config.ts" }, cwd: root }), undefined, "existing file");
    assert.equal(await planReadPathRepair({ toolInput: { path: "src" }, cwd: root }), undefined, "directory read");
    assert.equal(await planReadPathRepair({ toolInput: { path: "../outside.ts" }, cwd: root }), undefined);
    assert.equal(await planReadPathRepair({ toolInput: { path: "/etc/passwd" }, cwd: root }), undefined);
  });
});

test("selects only known ordinals at or above the predeclared threshold", async () => {
  await withRoot(async (root) => {
    await seed(root, { "src/config.ts": "x", "src/config.json": "y" });
    const plan = (await planReadPathRepair({ toolInput: { path: "src/confg.ts" }, cwd: root }))!;

    const knownOrdinal = plan.candidates[0]!.ordinal;
    assert.equal(selectReadPath(plan, { choice: knownOrdinal, confidence: 0.9 })?.ordinal, knownOrdinal);
    assert.equal(selectReadPath(plan, { choice: knownOrdinal, confidence: 0.99 })?.ordinal, knownOrdinal);
    assert.equal(selectReadPath(plan, { choice: knownOrdinal, confidence: 0.89 }), undefined, "below 0.9");
    assert.equal(selectReadPath(plan, { choice: knownOrdinal }), undefined, "missing confidence");
    assert.equal(selectReadPath(plan, { choice: 99, confidence: 0.99 }), undefined, "unknown ordinal");
    assert.equal(selectReadPath(plan, { choice: null, confidence: 0.99 }), undefined, "abstain");
  });
});

test("runReadPathSelection makes one bounded request and maps every failure class", async () => {
  await withRoot(async (root) => {
    await seed(root, { "src/config.ts": "x" });
    const plan = (await planReadPathRepair({ toolInput: { path: "src/confg.ts" }, cwd: root }))!;
    const ordinal = plan.candidates[0]!.ordinal;

    let tick = 0;
    const now = () => (tick += 5);

    const selected = scriptedClient([{ choice: ordinal, confidence: 0.97, model: "jev" }]);
    const selectedResult = await runReadPathSelection({ client: selected.client, plan, now });
    assert.equal(selectedResult.status, "selected");
    assert.equal(selectedResult.selectedPath, plan.candidates[0]!.path);
    assert.equal(selectedResult.confidence, 0.97);
    assert.equal(selected.calls(), 1, "zero retries");
    assert.equal(selectedResult.latencyMs, 5);

    assert.equal((await runReadPathSelection({ client: scriptedClient([{ choice: null, confidence: 0.2 }]).client, plan })).status, "abstain");
    assert.equal((await runReadPathSelection({ client: scriptedClient([{ choice: ordinal, confidence: 0.4 }]).client, plan })).status, "low-confidence");
    assert.equal((await runReadPathSelection({ client: scriptedClient([{ choice: 42, confidence: 0.99 }]).client, plan })).status, "malformed");

    const rateLimited = { choose: async () => { throw Object.assign(new Error("429"), { kind: "rate-limited" }); } };
    const transport = { choose: async () => { throw new Error("boom"); } };
    assert.equal((await runReadPathSelection({ client: rateLimited, plan })).status, "rate-limited");
    assert.equal((await runReadPathSelection({ client: transport, plan })).status, "transport");

    const hanging: JevClient = { choose: (_request, signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted"))); }) };
    const timedOut = await runReadPathSelection({ client: hanging, plan, timeoutMs: 10 });
    assert.equal(timedOut.status, "timeout");
  });
});

test("validates the selected path for containment and readability before mutation", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "welder-outside-"));
    try {
      await seed(root, { "src/config.ts": "x" });
      await writeFile(path.join(outside, "secret.ts"), "s", "utf8");
      await symlink(path.join(outside, "secret.ts"), path.join(root, "escape.ts"));

      const plan = { requestedPath: "src/confg.ts", candidates: [{ ordinal: 1, path: "src/config.ts" }, { ordinal: 2, path: "escape.ts" }] };
      assert.equal(await validateReadPathSelection({ plan, ordinal: 1, cwd: root }), "src/config.ts");
      assert.equal(await validateReadPathSelection({ plan, ordinal: 2, cwd: root }), undefined, "escaping symlink");
      assert.equal(await validateReadPathSelection({ plan, ordinal: 9, cwd: root }), undefined, "unknown ordinal");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("metadata-only counters distinguish every outcome without paths", () => {
  const state = createReadPathState();
  recordReadPathSelection(state, "selected");
  recordReadPathSelection(state, "abstain");
  recordReadPathSelection(state, "low-confidence");
  recordReadPathSelection(state, "timeout");
  recordReadPathSelection(state, "transport");
  recordReadPathRepair(state, true);
  recordReadPathRepair(state, false);

  assert.deepEqual(state, {
    eligible: 5, selected: 1, abstained: 1, lowConfidence: 1, failed: 2, repaired: 2, provisionalCorrect: 1, provisionalIncorrect: 1,
  });
  const summary = summarizeReadPathState(state);
  assert.equal(summary, summarizeReadPathState(state));
  assert.doesNotMatch(summary, /src\/|\.ts\b|\/Users\//);
});
