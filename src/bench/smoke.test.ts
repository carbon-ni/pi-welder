import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createOpenRouterClient, runSmoke } from "./smoke.ts";
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
