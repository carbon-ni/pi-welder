import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";

import { logDir, modelMeta, sessionId } from "./pi-context.ts";

test("logDir resolves under context cwd", () => {
  assert.equal(logDir({ cwd: "/workspace/project" } as any), path.join("/workspace/project", ".pi", "welder-log"));
});

test("sessionId uses session manager when available", () => {
  assert.equal(sessionId({ sessionManager: { getSessionId: () => "s1" } } as any), "s1");
});

test("sessionId and modelMeta fall back to unknown", () => {
  assert.equal(sessionId({} as any), "unknown");
  assert.deepEqual(modelMeta({} as any), { provider: "unknown", model: "unknown" });
});

test("modelMeta reads provider and model id", () => {
  assert.deepEqual(modelMeta({ model: { provider: "p", id: "m" } } as any), { provider: "p", model: "m" });
});
