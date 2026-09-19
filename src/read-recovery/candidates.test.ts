import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MAX_PATH_CANDIDATES,
  generateReadPathCandidates,
  rankPathCandidates,
  validateCandidatePath,
} from "./candidates.ts";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "welder-readpath-"));
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

test("ranks deterministically: identical basename, then prefix, length, directories, lexicographic", () => {
  const requested = "src/app/config.ts";
  const paths = [
    "src/app/config.json",
    "lib/config.ts",
    "src/other/myconfig.ts",
    "src/app/config.test.ts",
    "zzz.ts",
  ];
  const ranked = rankPathCandidates(requested, paths);
  assert.deepEqual(ranked, rankPathCandidates(requested, [...paths].reverse()));
  assert.equal(ranked[0], "lib/config.ts", "identical basename wins");
  assert.equal(ranked[1], "src/app/config.test.ts", "then longer common basename prefix");
  assert.equal(ranked[2], "src/app/config.json");
  assert.ok(ranked.indexOf("src/app/config.json") < ranked.indexOf("src/other/myconfig.ts"));

  // Ties fall back to lexicographic order.
  assert.deepEqual(rankPathCandidates("a.ts", ["b/x.ts", "a/z.ts"]), ["a/z.ts", "b/x.ts"]);
});

test("generates at most five relative candidates ordered by similarity near the requested path", async () => {
  await withRoot(async (root) => {
    await seed(root, {
      "src/app/config.ts": "a",
      "src/app/config.json": "b",
      "src/app/config.test.ts": "c",
      "src/app/config.spec.ts": "d",
      "src/app/config.backup.ts": "e",
      "src/app/config.old.ts": "f",
      "unrelated/file.ts": "g",
    });

    const candidates = await generateReadPathCandidates({ cwd: root, requestedPath: "src/app/configy.ts" });
    assert.ok(candidates);
    assert.ok(candidates.length <= MAX_PATH_CANDIDATES);
    assert.deepEqual(candidates.map((candidate) => candidate.ordinal), [1, 2, 3, 4, 5]);
    for (const candidate of candidates) {
      assert.ok(!path.isAbsolute(candidate.path));
      assert.ok(!candidate.path.includes(".."));
    }
    // Deterministic across runs.
    assert.deepEqual(await generateReadPathCandidates({ cwd: root, requestedPath: "src/app/configy.ts" }), candidates);
  });
});

test("fails closed on absolute paths, traversal, existing files, and directory reads", async () => {
  await withRoot(async (root) => {
    await seed(root, { "src/app/config.ts": "a", "src/other/thing.ts": "b" });
    await mkdir(path.join(root, "empty"), { recursive: true });

    assert.equal(await generateReadPathCandidates({ cwd: root, requestedPath: "/etc/passwd" }), undefined);
    assert.equal(await generateReadPathCandidates({ cwd: root, requestedPath: "../../etc/passwd" }), undefined);
    assert.equal(await generateReadPathCandidates({ cwd: root, requestedPath: "src/../src/app/config.ts" }), undefined);
    assert.equal(await generateReadPathCandidates({ cwd: root, requestedPath: "src/app/config.ts" }), undefined, "existing file");
    assert.equal(await generateReadPathCandidates({ cwd: root, requestedPath: "src/app" }), undefined, "directory read");
    assert.equal(await generateReadPathCandidates({ cwd: root, requestedPath: "" }), undefined);
    assert.equal(await generateReadPathCandidates({ cwd: root, requestedPath: "empty/nothere.ts" }), undefined, "no readable candidates");
  });
});

test("symlinks escaping the cwd are never candidates", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "welder-outside-"));
    try {
      await writeFile(path.join(outside, "secret.ts"), "secret", "utf8");
      await mkdir(path.join(root, "src"), { recursive: true });
      await symlink(path.join(outside, "secret.ts"), path.join(root, "src", "linked.ts"));
      await writeFile(path.join(root, "src", "real.ts"), "real", "utf8");

      const candidates = await generateReadPathCandidates({ cwd: root, requestedPath: "src/missing.ts" });
      assert.ok(candidates);
      assert.deepEqual(candidates.map((candidate) => candidate.path), ["src/real.ts"]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("validateCandidatePath re-checks containment and readability", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(path.join(tmpdir(), "welder-outside2-"));
    try {
      await seed(root, { "src/ok.ts": "ok" });
      await writeFile(path.join(outside, "secret.ts"), "secret", "utf8");
      await mkdir(path.join(root, "dir"), { recursive: true });
      await symlink(path.join(outside, "secret.ts"), path.join(root, "escape.ts"));

      assert.equal(await validateCandidatePath({ cwd: root, candidatePath: "src/ok.ts" }), "src/ok.ts");
      assert.equal(await validateCandidatePath({ cwd: root, candidatePath: "/etc/passwd" }), undefined);
      assert.equal(await validateCandidatePath({ cwd: root, candidatePath: "../outside.ts" }), undefined);
      assert.equal(await validateCandidatePath({ cwd: root, candidatePath: "escape.ts" }), undefined);
      assert.equal(await validateCandidatePath({ cwd: root, candidatePath: "dir" }), undefined);
      assert.equal(await validateCandidatePath({ cwd: root, candidatePath: "src/missing.ts" }), undefined);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
