import { test } from "node:test";
import assert from "node:assert/strict";

import { createTypeSafeJevClient, type JevSelectionRequest } from "./typesafe.ts";

const request: JevSelectionRequest = {
  candidates: [
    { ordinal: 1, window: "first" },
    { ordinal: 2, window: "second" },
  ],
  requestedEditText: "replacement",
};

test("TypeSafe client sends a typed choice request and parses the answer", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const client = createTypeSafeJevClient({
    apiKey: "test-key",
    fetch: async (url, init) => {
      captured = { url: String(url), init };
      return new Response(JSON.stringify({
        model: "jev-test",
        answers: { selection: { type: "choice", choice: "candidate-2", confidence: 0.99, probabilities: { "candidate-1": 0.01, "candidate-2": 0.99 } } },
      }), { status: 200 });
    },
  });

  const result = await client.choose(request, new AbortController().signal);

  assert.equal(result.choice, 2);
  assert.equal(result.confidence, 0.99);
  assert.equal(result.model, "jev-test");
  assert.equal(captured?.url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(captured?.init?.headers && new Headers(captured!.init!.headers).get("authorization"), "Bearer test-key");
  const body = JSON.parse(String(captured?.init?.body));
  assert.deepEqual(Object.keys(body.questions), ["selection"]);
  assert.equal(body.questions.selection.type, "choice");
  assert.equal(body.questions.selection.criteria["candidate-1"], "Candidate 1");
  assert.equal(body.questions.selection.criteria.abstain, "No candidate is sufficiently supported; do not select one.");
});

test("TypeSafe client rejects malformed or failed responses without exposing payloads", async () => {
  const malformed = createTypeSafeJevClient({ apiKey: "key", fetch: async () => new Response("{}", { status: 200 }) });
  await assert.rejects(() => malformed.choose(request, new AbortController().signal), /malformed/i);

  const limited = createTypeSafeJevClient({ apiKey: "key", fetch: async () => new Response("rate limited", { status: 429 }) });
  await assert.rejects(limited.choose(request, new AbortController().signal), (error: any) => error.kind === "rate-limited");
});

// Opt-in smoke against the real TypeSafe API. Runs only when BOTH
// TYPESAFE_API_KEY and WELDER_SMOKE_JEV=1 are set; writes only an ignored
// local artifact under .tmp/ with terminal status/latency/model — never proof
// of provider retention, precision, or production safety.
test("real-model smoke (opt-in)", { skip: process.env.TYPESAFE_API_KEY && process.env.WELDER_SMOKE_JEV === "1" ? false : "opt-in only" }, async () => {
  const { createTypeSafeJevClient: realClient } = await import("./typesafe.ts");
  const client = realClient({ apiKey: process.env.TYPESAFE_API_KEY! });
  const started = Date.now();
  let status = "transport";
  try {
    const answer = await client.choose({
      candidates: [
        { ordinal: 1, window: "function total(items) {\n  return items.length;\n}" },
        { ordinal: 2, window: "function total(items) {\n  return items.length;\n}" },
      ],
      requestedEditText: "return count;",
    }, AbortSignal.timeout(2_000));
    status = answer.choice === null ? "abstain" : `selected:${answer.choice}`;
  } catch (error: any) {
    status = error?.kind ?? "transport";
  }
  const { appendFile, mkdir } = await import("node:fs/promises");
  await mkdir(".tmp", { recursive: true });
  await appendFile(".tmp/jev-smoke.jsonl", `${JSON.stringify({ ts: new Date().toISOString(), status, latencyMs: Date.now() - started })}\n`);
});
