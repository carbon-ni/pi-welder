/**
 * TASK-0038 — real AgentSession tests with an injected bash classifier.
 * pi-ai's public faux provider scripts the assistant call; the wrapper is the
 * `write` tool, so prepare -> validate -> execute runs for real. No network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createAgentSession, createBashTool, createWriteToolDefinition, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createBashRouteState, wrapToolForBashRouting, type BashDelegate, type ToolLike } from "../command-routing/wrapper.ts";
import type { BashJudgmentClient } from "./contract.ts";

async function loadPiAi(): Promise<any> {
  // `@earendil-works/pi-ai` is an exact devDependency: the test runtime needs it
  // explicitly, because a clean install keeps it nested under the host package.
  return import("@earendil-works/pi-ai");
}

const piBash: BashDelegate = async ({ command, timeout, cwd, signal, toolCallId }) => {
  const tool = createBashTool(cwd);
  const result = await tool.execute(toolCallId, { command, ...(timeout === undefined ? {} : { timeout }) }, signal);
  return { content: result.content, details: result.details, isError: false };
};

async function withSession(
  args: Record<string, unknown>,
  judge: BashJudgmentClient | undefined,
  run: (result: { text: string; isError: boolean; judged: number; delegated: number }) => void,
): Promise<void> {
  const ai = await loadPiAi();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "welder-jev-"));
  const agentDir = path.join(root, ".agent");
  await fs.mkdir(agentDir, { recursive: true });

  const faux = ai.createFauxCore({ provider: "faux-jev", models: [{ id: "faux-1" }] });
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall("write", args)),
    ai.fauxAssistantMessage(ai.fauxText("done")),
  ]);

  const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: path.join(agentDir, "auth.json") });
  modelRuntime.registerProvider("faux-jev", {
    name: "faux", apiKey: "test", api: faux.api, baseUrl: "http://localhost/v1", streamSimple: faux.streamSimple,
    models: faux.models.map((model: any) => ({
      id: model.id, name: model.name ?? model.id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0 }, contextWindow: 100_000, maxTokens: 4_096,
    })),
  });

  let judged = 0;
  let delegated = 0;
  const counted: BashDelegate = async (request) => { delegated++; return piBash(request); };
  const countingJudge = judge === undefined ? undefined : {
    judge: (request: any, signal?: AbortSignal) => { judged++; return judge.judge(request, signal); },
  };

  const wrapper = wrapToolForBashRouting({
    builtin: createWriteToolDefinition(root) as unknown as ToolLike,
    toolName: "write",
    state: createBashRouteState({ isEnabled: () => true, isTrusted: () => true }),
    delegate: counted,
    resolveBuiltin: (cwd) => createWriteToolDefinition(cwd) as unknown as ToolLike,
    nextToken: () => "opaque-jev-token",
    ...(countingJudge === undefined ? {} : { judgeBash: countingJudge }),
    judgmentTimeoutMs: 500,
  });

  const { session } = await createAgentSession({
    cwd: root, agentDir, modelRuntime, model: faux.getModel(),
    tools: ["write"], customTools: [wrapper as never], noTools: "builtin",
  });

  try {
    await session.prompt("run it");
    const messages = session.messages as unknown as Array<{ role: string; content?: unknown[]; isError?: boolean }>;
    const result = messages.filter((message) => message.role === "toolResult")[0];
    run({
      text: Array.isArray(result?.content) ? result.content.map((block: any) => block?.text ?? "").join("\n") : "",
      isError: result?.isError === true,
      judged,
      delegated,
    });
  } finally {
    session.dispose?.();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const verdict = (choice: "bash" | "not-bash"): BashJudgmentClient => ({
  judge: async () => ({ answers: { bash: { choice, confidence: 0.9 } } }),
});

test("AgentSession: an arbitrary key with a bash verdict executes bash once", async () => {
  await withSession({ CMD: "printf jev-ran" }, verdict("bash"), (result) => {
    assert.equal(result.judged, 1, "the classifier ran once");
    assert.equal(result.delegated, 1, "bash executed once");
    assert.equal(result.isError, false, "the routed call is not an error");
    assert.match(result.text, /jev-ran/);
  });
});

test("AgentSession: a not-bash verdict preserves failure with zero bash", async () => {
  await withSession({ CMD: "printf jev-ran" }, verdict("not-bash"), (result) => {
    assert.equal(result.judged, 1);
    assert.equal(result.delegated, 0, "no bash execution");
    assert.equal(result.isError, true, "the call fails closed");
    assert.equal(result.text.includes("jev-ran"), false, "nothing ran");
  });
});

test("AgentSession: the exact shape stays deterministic and never classifies", async () => {
  await withSession({ command: "printf jev-ran", timeout: 20 }, verdict("not-bash"), (result) => {
    assert.equal(result.judged, 0, "TASK-0034 path is Jev-free");
    assert.equal(result.delegated, 1);
    assert.equal(result.isError, false);
    assert.match(result.text, /jev-ran/);
  });
});

test("AgentSession: without a classifier an eligible alias fails natively and runs nothing", async () => {
  await withSession({ CMD: "printf jev-ran" }, undefined, (result) => {
    assert.equal(result.judged, 0);
    assert.equal(result.delegated, 0);
    assert.equal(result.isError, true, "native validation failure, no execution");
  });
});
