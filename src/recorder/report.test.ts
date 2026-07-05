import { test } from "node:test";
import assert from "node:assert/strict";

import { formatFailureReport } from "./report.ts";
import type { FailureCluster } from "./aggregate.ts";

function cluster(overrides: Partial<FailureCluster> = {}): FailureCluster {
  return {
    toolName: "read",
    errorKind: "ENOENT",
    count: 3,
    samples: [
      { errorText: "ENOENT no such file 'foo.txt'", inputKeys: ["path"], ts: "2026-07-05T10:00:00Z" },
    ],
    ...overrides,
  };
}

test("formatFailureReport renders empty state", () => {
  const out = formatFailureReport([]);
  assert.match(out, /pi-welder failure report/i);
  assert.match(out, /no failures recorded/i);
});

test("formatFailureReport renders cluster header with count", () => {
  const out = formatFailureReport([cluster()]);
  assert.match(out, /read \/ ENOENT.*3/);
});

test("formatFailureReport renders samples with errorText", () => {
  const out = formatFailureReport([cluster()]);
  assert.match(out, /ENOENT no such file 'foo.txt'/);
});

test("formatFailureReport renders input keys for samples", () => {
  const out = formatFailureReport([cluster()]);
  assert.match(out, /input keys:.*path/);
});

test("formatFailureReport separates multiple clusters", () => {
  const out = formatFailureReport([
    cluster({ toolName: "read", errorKind: "ENOENT", count: 5 }),
    cluster({ toolName: "edit", errorKind: "EDIT_MISMATCH", count: 2 }),
  ]);
  const readIdx = out.indexOf("read");
  const editIdx = out.indexOf("edit");
  assert.ok(readIdx > -1);
  assert.ok(editIdx > -1);
  assert.ok(readIdx < editIdx); // clusters keep input order
  assert.match(out, /5/);
  assert.match(out, /2/);
});

test("formatFailureReport includes totals footer", () => {
  const out = formatFailureReport([
    cluster({ count: 5 }),
    cluster({ toolName: "edit", errorKind: "EDIT_MISMATCH", count: 2 }),
  ]);
  assert.match(out, /total failures.*7/i);
  assert.match(out, /clusters.*2/i);
});

test("formatFailureReport omits input keys when none present", () => {
  const out = formatFailureReport([
    cluster({ samples: [{ errorText: "boom", inputKeys: [], ts: "t" }] }),
  ]);
  assert.doesNotMatch(out, /input keys:/);
});

test("formatFailureReport header includes event source hint", () => {
  const out = formatFailureReport([cluster()]);
  assert.match(out, /source:.*jsonl/i);
});
