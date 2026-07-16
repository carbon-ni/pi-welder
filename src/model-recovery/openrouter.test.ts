import { test } from "node:test";
import assert from "node:assert/strict";

import { callEditRecoveryModel } from "./openrouter.ts";

test("calls configured OpenRouter model and parses fenced JSON", async () => {
  let request: RequestInit | undefined;
  const result = await callEditRecoveryModel({ model: "cheap/model", prompt: "locate", apiKey: "secret", baseUrl: "https://router.test/api/v1", fetchImpl: async (_url, init) => {
    request = init;
    return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n{\"decision\":\"repair\",\"confidence\":0.95,\"repairs\":[{\"index\":0,\"oldText\":\"exact\"}]}\n```" } }] }), { status: 200 });
  }});

  assert.equal(result.decision, "repair");
  assert.equal(result.repairs[0]?.oldText, "exact");
  assert.match(String(request?.body), /cheap\/model/);
});

test("rejects malformed model response", async () => {
  await assert.rejects(() => callEditRecoveryModel({ model: "cheap/model", prompt: "locate", apiKey: "secret", baseUrl: "https://router.test", fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 }) }), /valid JSON/);
});
