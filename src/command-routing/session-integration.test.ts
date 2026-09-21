/**
 * TASK-0034 — real AgentSession integration through the public SDK.
 *
 * Drives an assistant tool call end to end: the session's agent loop calls
 * `prepareArguments`, validates against the strict write schema, calls
 * `execute`, and records the tool result. A scripted provider
 * (`createFauxCore`, a public pi-ai test provider) supplies the assistant tool
 * call, so no network or API key is involved.
 *
 * Construction note: in this SDK path a same-name custom tool is selected by
 * disabling the built-in defaults (`noTools: "builtin"`). The extension host's
 * same-name override is documented behavior and is covered separately by the
 * composition-root registration test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createAgentSession, createBashTool, createWriteToolDefinition, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createBashRouteState, wrapToolForBashRouting, type BashDelegate, type RoutedAudit, type ToolLike } from "./wrapper.ts";

/** pi-ai is reached through the SDK's public export map (no nested paths). */
async function loadPiAi(): Promise<any> {
  // `@earendil-works/pi-ai` is an exact devDependency: the test runtime needs it
  // explicitly, because a clean install keeps it nested under the host package.
  return import("@earendil-works/pi-ai");
}

const realBashDelegate: BashDelegate = async ({ command, timeout, cwd, signal, toolCallId }) => {
  const tool = createBashTool(cwd);
  const result = await tool.execute(toolCallId, { command, ...(timeout === undefined ? {} : { timeout }) }, signal);
  return { content: result.content, details: result.details, isError: false };
};

interface SessionHarness {
  marker: string;
  audits: RoutedAudit[];
  run(): Promise<Array<{ toolName: string; isError: boolean; text: string }>>;
  cleanup(): Promise<void>;
}

async function runSession(options: {
  command: string;
  isEnabled: boolean;
  delegate?: BashDelegate;
}): Promise<SessionHarness> {
  const ai = await loadPiAi();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "welder-session-test-"));
  const agentDir = path.join(root, ".agent");
  await fs.mkdir(agentDir, { recursive: true });
  const marker = path.join(root, "counter.txt");

  const faux = ai.createFauxCore({ provider: "faux-welder", models: [{ id: "faux-1" }] });
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall("write", { command: options.command, timeout: 20 })),
    ai.fauxAssistantMessage(ai.fauxText("finished")),
  ]);

  const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: path.join(agentDir, "auth.json") });
  modelRuntime.registerProvider("faux-welder", {
    name: "faux",
    apiKey: "test",
    api: faux.api,
    baseUrl: "http://localhost/v1",
    streamSimple: faux.streamSimple,
    models: faux.models.map((model: any) => ({
      id: model.id, name: model.name ?? model.id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0 }, contextWindow: 100_000, maxTokens: 4_096,
    })),
  });

  const audits: RoutedAudit[] = [];
  const routeState = createBashRouteState({ isEnabled: () => options.isEnabled, isTrusted: () => true });
  const wrapper = wrapToolForBashRouting({
    builtin: createWriteToolDefinition(root) as unknown as ToolLike,
    toolName: "write",
    state: routeState,
    delegate: options.delegate ?? realBashDelegate,
    resolveBuiltin: (cwd) => createWriteToolDefinition(cwd) as unknown as ToolLike,
    nextToken: () => "opaque-session-token",
    onRouted: (audit) => audits.push(audit),
  });

  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    tools: ["write"],
    customTools: [wrapper as never],
    noTools: "builtin",
  });

  return {
    marker,
    audits,
    async run() {
      await session.prompt("run the command");
      return session.messages
        .filter((message: any) => message.role === "toolResult")
        .map((message: any) => ({
          toolName: message.toolName,
          isError: message.isError === true,
          text: Array.isArray(message.content)
            ? message.content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("\n")
            : "",
        }));
    },
    async cleanup() {
      session.dispose?.();
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
}

test("AgentSession: an assistant write(command,timeout) call routes to bash exactly once and succeeds", async () => {
  const harness = await runSession({ command: "printf session-output", isEnabled: true });
  try {
    const results = await harness.run();

    assert.equal(results.length, 1, "one tool result for the single tool call");
    assert.equal(results[0]!.toolName, "write");
    assert.equal(results[0]!.isError, false, "a routed call returns a non-error result");
    assert.match(results[0]!.text, /session-output/, "the model sees the real bash output");
    assert.deepEqual(harness.audits, [{ sourceTool: "write", targetTool: "bash", toolCallId: harness.audits[0]!.toolCallId }]);
    assert.equal(JSON.stringify(harness.audits).includes("printf"), false, "the command never enters the audit");
  } finally {
    await harness.cleanup();
  }
});

test("AgentSession: exactly-once proof through an appended marker file", async () => {
  const harness = await runSession({ command: "printf x >> counter-ran.txt", isEnabled: true });
  try {
    const results = await harness.run();

    assert.equal(results[0]!.isError, false);
    const counter = await fs.readFile(path.join(path.dirname(harness.marker), "counter-ran.txt"), "utf8").catch(() => "");
    assert.equal(counter, "x", "the command ran exactly once");
    assert.equal(harness.audits.length, 1, "one route audit for one call");
  } finally {
    await harness.cleanup();
  }
});

test("AgentSession: disabled routing stays on native validation and never executes", async () => {
  const harness = await runSession({ command: "printf x >> counter-disabled.txt", isEnabled: false });
  try {
    const results = await harness.run();

    assert.equal(results.length, 1);
    assert.equal(results[0]!.isError, true, "native validation rejects the bash shape");
    assert.match(results[0]!.text, /Validation failed for tool "write"/);
    assert.equal(harness.audits.length, 0, "no route audit when disabled");
    await assert.rejects(
      () => fs.readFile(path.join(path.dirname(harness.marker), "counter-disabled.txt"), "utf8"),
      "nothing executed",
    );
  } finally {
    await harness.cleanup();
  }
});

test("AgentSession: a bash capability failure surfaces as an error result, never a success", async () => {
  const failing: BashDelegate = async () => { throw new Error("bash capability unavailable"); };
  const harness = await runSession({ command: "printf never", isEnabled: true, delegate: failing });
  try {
    const results = await harness.run();

    assert.equal(results[0]!.isError, true, "a capability failure is an error result");
    assert.match(results[0]!.text, /bash execution failed/);
    assert.match(results[0]!.text, /bash capability unavailable/);
  } finally {
    await harness.cleanup();
  }
});