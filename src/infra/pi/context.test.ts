import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { logDir, modelMeta, sessionId } from "./context.ts";

test("logDir resolves under context cwd", () => {
  assert.equal(logDir({ cwd: "/workspace/project" }), path.join("/workspace/project", ".pi", "welder-log"));
});

test("sessionId uses session manager when available", () => {
  assert.equal(sessionId({ sessionManager: { getSessionId: () => "s1" } }), "s1");
});

test("sessionId and modelMeta fall back to unknown", () => {
  assert.equal(sessionId({}), "unknown");
  assert.deepEqual(modelMeta({}), { provider: "unknown", model: "unknown" });
});

test("modelMeta reads provider and model id", () => {
  assert.deepEqual(modelMeta({ model: { provider: "p", id: "m" } }), { provider: "p", model: "m" });
});
