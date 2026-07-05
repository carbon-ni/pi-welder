import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import factory from "./index.ts";

interface Captured {
  handlers: Record<string, (event: any, ctx: any) => Promise<unknown>>;
  commands: Record<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>;
  statuses: Array<[string, string | undefined]>;
  notifies: Array<[string, string]>;
}

function loadExtension(): Captured {
  const captured: Captured = { handlers: {}, commands: {}, statuses: [], notifies: [] };
  const api = {
    on(event: string, handler: any) { captured.handlers[event] = handler; },
    registerCommand(name: string, def: any) { captured.commands[name] = def; },
  };
  factory(api as any);
  return captured;
}

function ctx(overrides: Partial<any> = {}): any {
  return {
    hasUI: true,
    cwd: overrides.cwd ?? process.cwd(),
    sessionManager: { getSessionId: () => overrides.sessionId ?? "test-session" },
    model: { provider: "test-provider", id: "test-model" },
    ui: {
      notify: (msg: string, kind: string) => { /* capture silently */ void kind; void msg; },
      setStatus: (key: string, value: string | undefined) => { void key; void value; },
    },
    ...overrides,
  };
}

test("factory registers tool_call/tool_result/context + session handlers and all commands", () => {
  const c = loadExtension();
  assert.ok(c.handlers["tool_call"], "tool_call handler registered");
  assert.ok(c.handlers["tool_result"], "tool_result handler registered");
  assert.ok(c.handlers["context"], "context handler registered");
  assert.ok(c.handlers["session_start"], "session_start handler registered");
  for (const cmd of ["welder-stats", "welder-status", "welder-reset", "welder-on", "welder-off", "welder-toggle", "welder-log", "welder-guidance", "welder-failures", "welder-guidance-limit", "welder-clear"]) {
    assert.ok(c.commands[cmd], `${cmd} command registered`);
  }
});

test("tool_call mutates event.input in place with repairs", async () => {
  const c = loadExtension();
  await c.handlers["session_start"]!({}, ctx());
  const event = {
    toolName: "edit",
    toolCallId: "1",
    input: { path: "a.ts", edits: { oldText: "x", newText: "y" }, limit: null },
  };
  await c.handlers["tool_call"]!(event, ctx());
  assert.deepEqual(event.input.edits, [{ oldText: "x", newText: "y" }]);
  assert.equal(!("limit" in event.input), true, "null limit stripped");
  assert.equal(event.input.path, "a.ts");
});

test("tool_call leaves valid input untouched", async () => {
  const c = loadExtension();
  await c.handlers["session_start"]!({}, ctx());
  const event = {
    toolName: "read",
    toolCallId: "1",
    input: { path: "a.ts", offset: 1, limit: 10 },
  };
  const before = JSON.parse(JSON.stringify(event.input));
  await c.handlers["tool_call"]!(event, ctx());
  assert.deepEqual(event.input, before);
});

test("tool_call returns undefined (never blocks)", async () => {
  const c = loadExtension();
  await c.handlers["session_start"]!({}, ctx());
  const ret = await c.handlers["tool_call"]!(
    { toolName: "edit", toolCallId: "1", input: { edits: "bare" } },
    ctx(),
  );
  assert.equal(ret, undefined);
});

test("repair writes one JSONL line to the session log", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "welder-it-"));
  try {
    const c = loadExtension();
    await c.handlers["session_start"]!({}, ctx({ cwd: dir, sessionId: "s1" }));
    await c.handlers["tool_call"]!(
      { toolName: "read", toolCallId: "1", input: { paths: '["a.ts","b.ts"]' } },
      ctx({ cwd: dir, sessionId: "s1" }),
    );
    const file = path.join(dir, ".pi", "welder-log", "s1.jsonl");
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const ev = JSON.parse(lines[0]!);
    assert.equal(ev.toolName, "read");
    assert.deepEqual(ev.repairs, ["parse-json"]);
    assert.equal(ev.wasRepaired, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("welder-off disables repair application; welder-on re-enables", async () => {
  const c = loadExtension();
  const cx = ctx();
  await c.handlers["session_start"]!({}, cx);
  await c.commands["welder-off"]!.handler("", cx);

  const event = { toolName: "edit", toolCallId: "1", input: { edits: { oldText: "x", newText: "y" } } };
  await c.handlers["tool_call"]!(event, cx);
  assert.deepEqual(event.input.edits, { oldText: "x", newText: "y" }, "not wrapped while off");

  await c.commands["welder-on"]!.handler("", cx);
  const event2 = { toolName: "edit", toolCallId: "2", input: { edits: { oldText: "x", newText: "y" } } };
  await c.handlers["tool_call"]!(event2, cx);
  assert.deepEqual(event2.input.edits, [{ oldText: "x", newText: "y" }], "wrapped after re-enable");
});

test("welder-stats surfaces repairs counted in-session", async () => {
  const c = loadExtension();
  let shown = "";
  const cx = ctx({ ui: { notify: (m: string) => { shown = m; }, setStatus: () => {} } });
  await c.handlers["session_start"]!({}, cx);
  await c.handlers["tool_call"]!({ toolName: "read", toolCallId: "1", input: { limit: null, paths: '["a"]' } }, cx);
  await c.commands["welder-stats"]!.handler("", cx);
  assert.match(shown, /parse-json/);
  assert.match(shown, /strip-null/);
});

test("welder-status summarizes runtime state", async () => {
  const c = loadExtension();
  let shown = "";
  const cx = ctx({
    cwd: "/workspace/project",
    sessionId: "status-session",
    ui: { notify: (m: string) => { shown = m; }, setStatus: () => {} },
  });
  await c.handlers["session_start"]!({}, cx);
  await c.commands["welder-off"]!.handler("", cx);
  await c.commands["welder-guidance-limit"]!.handler("2", cx);
  await c.handlers["tool_result"]!({ toolName: "read", input: {}, isError: true, content: "ENOENT" }, cx);

  await c.commands["welder-status"]!.handler("", cx);

  assert.match(shown, /enabled\s+: false/);
  assert.match(shown, /guidance limit\s+: 2/);
  assert.match(shown, /pending failures\s+: 1/);
  assert.match(shown, /status-session\.jsonl/);
});

test("welder-reset clears stats and recovery without changing enabled state", async () => {
  const c = loadExtension();
  let shown = "";
  const cx = ctx({ ui: { notify: (m: string) => { shown = m; }, setStatus: () => {} } });
  await c.handlers["session_start"]!({}, cx);
  await c.commands["welder-off"]!.handler("", cx);
  await c.handlers["tool_call"]!({ toolName: "read", toolCallId: "1", input: { paths: '["a"]' } }, cx);
  await c.handlers["tool_result"]!({ toolName: "read", input: {}, isError: true, content: "ENOENT" }, cx);

  await c.commands["welder-reset"]!.handler("", cx);
  await c.commands["welder-status"]!.handler("", cx);

  assert.match(shown, /enabled\s+: false/);
  assert.match(shown, /pending failures\s+: 0/);
  assert.match(shown, /tool calls seen\s+: 0/);
  assert.match(shown, /failed results\s+: 0/);
});

test("tool_result failures inject recovery guidance into next context", async () => {
  const c = loadExtension();
  const cx = ctx();
  await c.handlers["session_start"]!({}, cx);
  await c.handlers["tool_result"]!({
    toolName: "edit",
    input: { path: "a.ts", oldText: "missing" },
    isError: true,
    content: [{ type: "text", text: "EDIT_MISMATCH: oldText not found" }],
  }, cx);

  const out = await c.handlers["context"]!({ messages: [{ role: "user", content: "retry" }] }, cx) as any;
  assert.equal(out.messages.length, 2);
  assert.match(out.messages[1].content, /pi-welder recovery hints/);
  assert.match(out.messages[1].content, /read a fresh snippet/);
});

test("successful tool_result clears guidance for that tool", async () => {
  const c = loadExtension();
  const cx = ctx();
  await c.handlers["session_start"]!({}, cx);
  await c.handlers["tool_result"]!({ toolName: "read", input: {}, isError: true, content: "ENOENT" }, cx);
  await c.handlers["tool_result"]!({ toolName: "read", input: {}, isError: false, content: "ok" }, cx);

  const out = await c.handlers["context"]!({ messages: [{ role: "user", content: "next" }] }, cx) as any;
  assert.equal(out, undefined);
});

test("context guidance is injected only once per unchanged failure snapshot", async () => {
  const c = loadExtension();
  const cx = ctx();
  await c.handlers["session_start"]!({}, cx);
  await c.handlers["tool_result"]!({ toolName: "read", input: {}, isError: true, content: "ENOENT" }, cx);

  const first = await c.handlers["context"]!({ messages: [{ role: "user", content: "first" }] }, cx) as any;
  const second = await c.handlers["context"]!({ messages: [{ role: "user", content: "second" }] }, cx) as any;

  assert.equal(first.messages.length, 2);
  assert.equal(second, undefined);
});

test("welder-guidance command surfaces current recovery hints", async () => {
  const c = loadExtension();
  let shown = "";
  const cx = ctx({ ui: { notify: (m: string) => { shown = m; }, setStatus: () => {} } });
  await c.handlers["session_start"]!({}, cx);
  await c.handlers["tool_result"]!({ toolName: "read", input: { path: "missing.ts" }, isError: true, content: "ENOENT" }, cx);
  await c.commands["welder-guidance"]!.handler("", cx);
  assert.match(shown, /pi-welder recovery hints/);
  assert.match(shown, /verify the path/);
});

test("welder-failures command surfaces pending failures without guidance hints", async () => {
  const c = loadExtension();
  let shown = "";
  const cx = ctx({ ui: { notify: (m: string) => { shown = m; }, setStatus: () => {} } });
  await c.handlers["session_start"]!({}, cx);
  await c.handlers["tool_result"]!({ toolName: "read", input: { path: "missing.ts" }, isError: true, content: "ENOENT: no such file" }, cx);

  await c.commands["welder-failures"]!.handler("", cx);

  assert.match(shown, /pending recovery failures/);
  assert.match(shown, /read failed: ENOENT/);
  assert.doesNotMatch(shown, /hint:/);
});

test("welder-clear removes pending recovery guidance", async () => {
  const c = loadExtension();
  let shown = "";
  const cx = ctx({ ui: { notify: (m: string) => { shown = m; }, setStatus: () => {} } });
  await c.handlers["session_start"]!({}, cx);
  await c.handlers["tool_result"]!({ toolName: "read", input: {}, isError: true, content: "ENOENT" }, cx);

  await c.commands["welder-clear"]!.handler("", cx);

  const out = await c.handlers["context"]!({ messages: [{ role: "user", content: "next" }] }, cx) as any;
  assert.equal(out, undefined);
  assert.match(shown, /cleared/);
});

test("welder-guidance-limit updates max recent failures", async () => {
  const c = loadExtension();
  let shown = "";
  const cx = ctx({ ui: { notify: (m: string) => { shown = m; }, setStatus: () => {} } });
  await c.handlers["session_start"]!({}, cx);

  await c.commands["welder-guidance-limit"]!.handler("2", cx);
  await c.handlers["tool_result"]!({ toolName: "one", input: {}, isError: true, content: "1" }, cx);
  await c.handlers["tool_result"]!({ toolName: "two", input: {}, isError: true, content: "2" }, cx);
  await c.handlers["tool_result"]!({ toolName: "three", input: {}, isError: true, content: "3" }, cx);

  const out = await c.handlers["context"]!({ messages: [{ role: "user", content: "next" }] }, cx) as any;
  const content = out.messages[1].content;
  assert.match(shown, /guidance limit set to 2/);
  assert.doesNotMatch(content, /one failed/);
  assert.match(content, /two failed/);
  assert.match(content, /three failed/);
});

test("welder-guidance-limit rejects invalid values", async () => {
  const c = loadExtension();
  let shown = "";
  const cx = ctx({ ui: { notify: (m: string) => { shown = m; }, setStatus: () => {} } });
  await c.handlers["session_start"]!({}, cx);

  await c.commands["welder-guidance-limit"]!.handler("0", cx);

  assert.match(shown, /expected integer between 1 and 10/);
});

test("failing tool_result writes JSONL failure event and updates stats", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "welder-result-it-"));
  try {
    const c = loadExtension();
    let shown = "";
    const cx = ctx({
      cwd: dir,
      sessionId: "s-result",
      ui: { notify: (m: string) => { shown = m; }, setStatus: () => {} },
    });
    await c.handlers["session_start"]!({}, cx);
    await c.handlers["tool_result"]!({ toolName: "read", input: { path: "missing.ts" }, isError: true, content: "ENOENT: no such file" }, cx);

    const file = path.join(dir, ".pi", "welder-log", "s-result.jsonl");
    const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
    const ev = JSON.parse(lines[0]!);
    assert.equal(ev.eventType, "tool_result");
    assert.equal(ev.toolName, "read");
    assert.equal(ev.wasError, true);
    assert.equal(ev.errorKind, "ENOENT");

    await c.commands["welder-stats"]!.handler("", cx);
    assert.match(shown, /failed results : 1/);
    assert.match(shown, /read.*1/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
