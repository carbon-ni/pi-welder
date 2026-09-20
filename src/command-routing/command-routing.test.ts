import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BASH_TIMEOUT_MAX_SECONDS,
  MAX_PENDING_BASH_ROUTES,
  MAX_REASON_OUTPUT_CHARS,
  buildBashRouteReason,
  clearPendingBashRoutes,
  consumePendingBashRoute,
  createPendingBashRoutes,
  recognizeBashShapedCall,
  rememberPendingBashRoute,
  toBashRouteResult,
} from "./index.ts";

test("recognizes only exact bash shapes on read, write, and edit", () => {
  for (const tool of ["read", "write", "edit"]) {
    assert.deepEqual(recognizeBashShapedCall(tool, { command: "ls -la" }), { command: "ls -la" });
    assert.deepEqual(recognizeBashShapedCall(tool, { command: "ls -la", timeout: 30 }), { command: "ls -la", timeout: 30 });
  }
  assert.equal(recognizeBashShapedCall("bash", { command: "ls" }), undefined, "attempted bash is never rerouted");
  assert.equal(recognizeBashShapedCall("ast_map", { command: "ls" }), undefined, "unknown tools are never rerouted");
});

test("abstains on unknown fields, missing command, invalid types, and bad ranges", () => {
  for (const tool of ["read", "write", "edit"]) {
    assert.equal(recognizeBashShapedCall(tool, {}), undefined);
    assert.equal(recognizeBashShapedCall(tool, { timeout: 5 }), undefined, "command is mandatory");
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", path: "a.ts" }), undefined, "extra key");
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: 5, cwd: "/tmp" }), undefined, "extra key");
    assert.equal(recognizeBashShapedCall(tool, { command: "" }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "   " }), undefined, "whitespace-only command");
    assert.equal(recognizeBashShapedCall(tool, { command: 42 }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: "5" }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: Number.NaN }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: Number.POSITIVE_INFINITY }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: 0 }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: -1 }), undefined);
    assert.equal(recognizeBashShapedCall(tool, { command: "ls", timeout: BASH_TIMEOUT_MAX_SECONDS + 1 }), undefined);
    assert.deepEqual(recognizeBashShapedCall(tool, { command: "ls", timeout: BASH_TIMEOUT_MAX_SECONDS }), { command: "ls", timeout: BASH_TIMEOUT_MAX_SECONDS }, "the maximum accepted timeout is inclusive");
    assert.equal(recognizeBashShapedCall(tool, null), undefined);
    assert.equal(recognizeBashShapedCall(tool, "ls"), undefined);
    assert.equal(recognizeBashShapedCall(tool, ["ls"]), undefined);
  }
  assert.deepEqual(recognizeBashShapedCall("edit", { command: "ls", timeout: undefined }), { command: "ls" }, "an explicit undefined timeout is treated as absent");
});

test("the reason states the block and outcome but never the command", () => {
  const outcome = { text: "SECRET_COMMAND_OUTPUT\ndone", isError: false };
  const reason = buildBashRouteReason("write", outcome);
  assert.match(reason, /blocked this write call/);
  assert.match(reason, /no write was applied/);
  assert.match(reason, /ran once through bash and completed/);
  assert.match(reason, /SECRET_COMMAND_OUTPUT/);
  assert.equal(reason.includes("command:"), false, "the reason never echoes the command");
  assert.equal(reason.includes("ls -la"), false);

  const failure = buildBashRouteReason("read", { text: "boom", isError: true });
  assert.match(failure, /failed/);
  assert.match(failure, /blocked this read call/);
});

test("the reason bounds large output and tolerates empty output", () => {
  const huge = buildBashRouteReason("edit", { text: "x".repeat(MAX_REASON_OUTPUT_CHARS + 5_000), isError: false });
  assert.equal(huge.includes("output truncated"), true);
  assert.equal(huge.length < MAX_REASON_OUTPUT_CHARS + 500, true);

  const empty = buildBashRouteReason("edit", { text: "", isError: false });
  assert.match(empty, /ran once through bash and completed/);
});

test("pending routes are correlated by call ID, bounded, and clearable", () => {
  const routes = createPendingBashRoutes();
  rememberPendingBashRoute(routes, { toolCallId: "a", sourceTool: "write", outcome: { text: "one", isError: false }, delivered: true });
  rememberPendingBashRoute(routes, { toolCallId: "b", sourceTool: "read", outcome: { text: "two", isError: true }, delivered: true });

  assert.deepEqual(toBashRouteResult(routes.get("a")!), { content: [{ type: "text", text: "one" }], details: {}, isError: false });
  const consumed = consumePendingBashRoute(routes, "a");
  assert.equal(consumed?.sourceTool, "write");
  assert.equal(consumePendingBashRoute(routes, "a"), undefined, "consumption is once only");
  assert.equal(consumePendingBashRoute(routes, undefined), undefined);

  for (let index = 0; index < MAX_PENDING_BASH_ROUTES + 5; index++) {
    rememberPendingBashRoute(routes, { toolCallId: `id-${index}`, sourceTool: "edit", outcome: { text: "x", isError: false }, delivered: true });
  }
  assert.equal(routes.size, MAX_PENDING_BASH_ROUTES, "bounded");
  assert.equal(routes.has("id-0"), false, "oldest evicted");

  clearPendingBashRoutes(routes);
  assert.equal(routes.size, 0);

  const withDetails = createPendingBashRoutes();
  rememberPendingBashRoute(withDetails, { toolCallId: "d", sourceTool: "edit", outcome: { text: "ok", details: { truncation: { truncated: true } }, isError: false }, delivered: true });
  assert.deepEqual(toBashRouteResult(withDetails.get("d")!).details, { truncation: { truncated: true } });
});
