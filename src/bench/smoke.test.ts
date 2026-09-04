import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createOpenRouterClient, FALLBACK_EPISODES, runSmoke } from "./smoke.ts";
import type { ModelClient } from "./runner.ts";

test("smoke without credentials does not run", async () => {
  const result = await runSmoke({ apiKey: "", dataset: [] });
  assert.equal(result.ran, false);
  assert.equal(result.reason, "missing-credentials");
});

test("smoke with injected fake client writes a bounded ignored report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-smoke-"));
  const client: ModelClient = {
    async complete() {
      return { content: JSON.stringify({ path: "f.ts", edits: [{ oldText: "a", newText: "b" }] }), tokens: 10, latencyMs: 3, provider: "mock", model: "mock-model" };
    },
  };
  const reportPath = path.join(root, "smoke-report.md");

  const result = await runSmoke({
    client,
    dataset: [{
      episodeId: "ep-1",
      kind: "repair-warning",
      sessionId: "s1",
      toolName: "edit",
      repairs: ["nest-edit-fields"],
      inputKeys: ["edits"],
      outcome: "valid",
    }],
    caps: { timeoutMs: 1000, retryCap: 1, concurrencyCap: 1, costBudgetUsd: 1, usdPerToken: 0.001 },
    reportPath,
  });

  assert.equal(result.ran, true);
  assert.equal(result.reportPath, reportPath);
  const report = await readFile(reportPath, "utf8");
  assert.match(report, /smoke/i);
  assert.match(report, /text-json/);
  assert.match(report, /B0-no-message/);
  assert.match(report, /B1-shipped/);
  assert.match(report, /mock-model/);
});

test("openrouter client requires an api key", () => {
  assert.throws(() => createOpenRouterClient(""), /api key/);
});

test("smoke falls back to a redacted hand-authored fixture when no episodes are recorded", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "welder-smoke-empty-"));
  const client: ModelClient = {
    async complete() {
      return { content: JSON.stringify({ path: "f.ts", edits: [{ oldText: "a", newText: "b" }] }), tokens: 10, latencyMs: 3, provider: "mock", model: "mock-model" };
    },
  };
  const reportPath = path.join(root, "smoke-report.md");

  const result = await runSmoke({ apiKey: "", client, logDir: path.join(root, "does-not-exist"), reportPath });

  assert.equal(result.ran, true);
  assert.equal(result.datasetSource, "fallback-fixture");
  const report = await readFile(reportPath, "utf8");
  assert.match(report, /fallback-fixture/);
  assert.match(report, /episodes: 3/);

  // Zero-content guarantee: fixture carries only structural metadata.
  const serialized = JSON.stringify(FALLBACK_EPISODES);
  for (const field of ["errorText", "content", "command\":", "oldText", "newText", "path\":", "prompt"]) {
    assert.ok(!serialized.includes(field), `fixture must not contain ${field}`);
  }
  assert.ok(FALLBACK_EPISODES.length >= 1);
  assert.ok(FALLBACK_EPISODES.every((episode) => episode.sessionId === "fixture"));
});
