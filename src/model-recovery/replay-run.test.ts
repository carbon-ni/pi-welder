import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REPLAY_BUDGET,
  REPLAY_TIMEOUT_MS,
  buildReplayWorksheet,
  parseReplayWorksheet,
  runShadowReplay,
  type PreparedPair,
} from "./replay-run.ts";
import { computeMetrics, parseWorksheet } from "./shadow-labels.ts";
import type { JevClient, JevSelectionResponse } from "../infra/typesafe.ts";

function prepared(id: string, ordinals: number[] = [1, 2]): PreparedPair {
  return {
    sessionId: "session-a",
    toolCallId: id,
    ts: "2026-01-01T00:00:00.000Z",
    candidateCount: ordinals.length,
    groundTruthOrdinal: 2,
    request: {
      candidates: ordinals.map((ordinal) => ({ ordinal, window: `window ${ordinal}` })),
      requestedEditText: "replacement",
      serializedBytes: 64,
    },
  };
}

function answerClient(responses: (JevSelectionResponse | Error)[], calls?: string[]): JevClient {
  let index = 0;
  return {
    async choose(_request, _signal) {
      const served = index++;
      calls?.push(`call-${served}`);
      const response = responses[Math.min(served, responses.length - 1)]!;
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("replays sequentially and maps high-confidence choices to selected rows", async () => {
  const calls: string[] = [];
  let inFlight = 0;
  let overlap = false;
  const client: JevClient = {
    async choose(_request, _signal) {
      if (inFlight > 0) overlap = true;
      inFlight++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      calls.push("choose");
      return { choice: 2, confidence: 0.99, model: "jev-test" };
    },
  };

  const result = await runShadowReplay({ prepared: [prepared("call-1"), prepared("call-2")], client });

  assert.equal(overlap, false, "replay calls must be sequential");
  assert.deepEqual(calls, ["choose", "choose"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0]!.selectedOrdinal, 2);
  assert.equal(result.rows[0]!.confidence, 0.99);
  assert.equal(result.rows[0]!.outcome, "selected");
  assert.equal(result.rows[0]!.labelStatus, "pending");
  assert.equal(result.rows[0]!.candidateCount, 2);
  assert.equal(result.rows[0]!.historicalTarget, 2);
  assert.equal(result.calls[0]!.model, "jev-test");
  assert.ok(result.calls[0]!.latencyMs >= 0);
  assert.deepEqual(result.stats, { pairs: 2, attempted: 2, budget: REPLAY_BUDGET, headroom: REPLAY_BUDGET - 2 });
});

test("enforces the predeclared budget: no calls after the cap, remainder reported as headroom", async () => {
  const calls: string[] = [];
  const result = await runShadowReplay({
    prepared: [prepared("call-1"), prepared("call-2"), prepared("call-3"), prepared("call-4")],
    client: answerClient([{ choice: 1, confidence: 0.99 }], calls),
    budget: 3,
  });

  assert.equal(calls.length, 3);
  assert.equal(result.rows.length, 3);
  assert.equal(result.stats.attempted, 3);
  assert.equal(result.stats.headroom, 0);
});

test("failed requests are recorded and never retried", async () => {
  const transportError = Object.assign(new Error("boom"), { kind: "transport" });
  const calls: string[] = [];
  const result = await runShadowReplay({
    prepared: [prepared("call-1"), prepared("call-2")],
    client: answerClient([transportError, { choice: null }], calls),
  });

  assert.deepEqual(calls, ["call-0", "call-1"], "each pair gets exactly one attempt");
  assert.equal(result.rows[0]!.outcome, "transport");
  assert.equal(result.rows[1]!.outcome, "abstain");
  assert.equal(result.rows[0]!.selectedOrdinal, undefined);
});

test("aborted slow requests count against the budget as timeout failures, without retries", async () => {
  const calls: string[] = [];
  const hanging: JevClient = {
    choose(_request, signal) {
      calls.push("choose");
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
  };

  const result = await runShadowReplay({ prepared: [prepared("call-1"), prepared("call-2")], client: hanging, timeoutMs: 10 });

  assert.equal(calls.length, 2);
  assert.equal(result.rows[0]!.outcome, "timeout");
  assert.equal(result.rows[1]!.outcome, "timeout");
  assert.equal(result.stats.attempted, 2);
});

test("abstentions and sub-threshold or malformed answers keep rows unlabeled", async () => {
  const result = await runShadowReplay({
    prepared: [prepared("call-a"), prepared("call-b"), prepared("call-c")],
    client: answerClient([
      { choice: null, confidence: 0.8 },
      { choice: 2, confidence: 0.5 },
      { choice: 9, confidence: 0.99 },
    ]),
    now: (() => { let tick = 0; return () => tick += 5; })(),
  });

  assert.equal(result.rows[0]!.outcome, "abstain");
  assert.equal(result.rows[1]!.outcome, "low-confidence");
  assert.equal(result.rows[1]!.selectedOrdinal, undefined);
  assert.equal(result.rows[2]!.outcome, "malformed");
  assert.equal(result.rows[0]!.latencyMs, 5);
});

test("the replay worksheet extends the shadow-labels format with historical-target and stays byte-identical", () => {
  const build = () => buildReplayWorksheet([
    {
      toolCallId: "call-2", sessionId: "session-b", ts: "2026-01-02T00:00:00.000Z", candidateCount: 2,
      selectedOrdinal: 1, confidence: 0.99, labelStatus: "pending", outcome: "selected", latencyMs: 120,
      linked: true, historicalTarget: 2,
    },
    {
      toolCallId: "call-1", sessionId: "session-a", ts: "2026-01-01T00:00:00.000Z", candidateCount: 3,
      labelStatus: "pending", outcome: "timeout", latencyMs: 2000, linked: true, historicalTarget: 1,
    },
  ]);

  const worksheet = build();
  assert.equal(worksheet, build(), "same rows must render byte-identically");
  const header = worksheet.split("\n")[0]!.split("\t");
  assert.ok(header.includes("historical-target"), "worksheet gains the historical-target column");
  assert.ok(header.includes("verified-target"), "worksheet keeps the reviewer column");
  assert.ok(header.indexOf("historical-target") < header.indexOf("verified-target"));

  const roundTripped = parseReplayWorksheet(worksheet);
  assert.equal(roundTripped[0]!.historicalTarget, 1);
  assert.equal(roundTripped[1]!.historicalTarget, 2);
  assert.equal(roundTripped[1]!.selectedOrdinal, 1);

  // Metrics compatibility: the existing parser and protocol ignore the new column.
  const metrics = computeMetrics(parseWorksheet(worksheet));
  assert.equal(metrics.attemptedSelections, 1);
  assert.equal(metrics.reviewedAttempted, 0);
  assert.equal(metrics.precision, undefined);
});
