/**
 * TASK-0040 regression — a real AgentSession must not classify normal calls.
 *
 * The wrapped built-in `read` is the session's read tool, and the classifier
 * throws on use. A schema-valid call, including one whose path does not exist,
 * must go native; the deterministic result repair still runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createAgentSession, createReadToolDefinition, DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { handleToolCall, handleToolResult } from "../handlers.ts";
import { createRuntime } from "../runtime.ts";
import { createBashRouteState, wrapToolForBashRouting, type ToolLike } from "./wrapper.ts";

async function loadPiAi(): Promise<any> {
  // `@earendil-works/pi-ai` is an exact devDependency: the test runtime needs it
  // explicitly, because a clean install keeps it nested under the host package.
  return import("@earendil-works/pi-ai");
}

interface Observed {
  text: string;
  isError: boolean;
  judged: number;
  bashRuns: number;
  readPathCalls: number;
  restored: number;
}

async function runRead(
  toolArguments: Record<string, unknown>,
  seed: (root: string) => Promise<void>,
  options: { readPathRepair?: boolean } = {},
): Promise<Observed> {
  const ai = await loadPiAi();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "welder-0040-"));
  const agentDir = path.join(root, ".agent");
  await fs.mkdir(agentDir, { recursive: true });
  await seed(root);

  const faux = ai.createFauxCore({ provider: "faux-welder", models: [{ id: "faux-1" }] });
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall("read", toolArguments)),
    ai.fauxAssistantMessage(ai.fauxText("done")),
  ]);

  const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: path.join(agentDir, "auth.json") });
  modelRuntime.registerProvider("faux-welder", {
    name: "faux", apiKey: "test", api: faux.api, baseUrl: "http://localhost/v1", streamSimple: faux.streamSimple,
    models: faux.models.map((model: any) => ({
      id: model.id, name: model.name ?? model.id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0 }, contextWindow: 100_000, maxTokens: 4_096,
    })),
  });

  let judged = 0;
  let bashRuns = 0;
  let readPathCalls = 0;
  const runtime = createRuntime({
    ...(options.readPathRepair === true
      ? { readPathRepairEnabled: true, readPathClient: { choose: async () => { readPathCalls++; return { choice: 1, confidence: 0.99 }; } } as never }
      : {}),
  });
  const wrapper = wrapToolForBashRouting({
    builtin: createReadToolDefinition(root) as unknown as ToolLike,
    toolName: "read",
    state: createBashRouteState({ isEnabled: () => true, isTrusted: () => true }),
    delegate: async () => { bashRuns++; return { content: [{ type: "text", text: "bash ran" }] }; },
    resolveBuiltin: (cwd) => createReadToolDefinition(cwd) as unknown as ToolLike,
    judgeBash: { judge: async () => { judged++; return { answers: { bash: { choice: "bash" } } }; } },
  });

  const extension = {
    name: "welder-0040-handlers",
    factory: (pi: any) => {
      pi.on("tool_call", async (event: any, context: any) => { await handleToolCall(runtime, event, context); });
      pi.on("tool_result", async (event: any, context: any) => { await handleToolResult(runtime, event, context); });
    },
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, extensionFactories: [extension as never],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await resourceLoader.reload({ includeInlineFactories: true } as never);

  const { session } = await createAgentSession({
    cwd: root, agentDir, modelRuntime, model: faux.getModel(), tools: ["read"],
    customTools: [wrapper as never], noTools: "builtin", resourceLoader,
  });

  try {
    await session.prompt("read it");
    const messages = session.messages as unknown as Array<{ role: string; content?: unknown[]; isError?: boolean }>;
    const result = messages.filter((message) => message.role === "toolResult")[0];
    return {
      text: Array.isArray(result?.content) ? result.content.map((block: any) => block?.text ?? "").join("\n") : "",
      isError: result?.isError === true,
      judged,
      bashRuns,
      readPathCalls,
      restored: runtime.stats.repairsByAction.get("restore-read-path") ?? 0,
    };
  } finally {
    session.dispose?.();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

test("AgentSession: read({path:'README.md'}) runs natively with zero classifications", async () => {
  const observed = await runRead({ path: "README.md" }, async (root) => {
    await fs.writeFile(path.join(root, "README.md"), "# real readme content\n");
  });

  assert.equal(observed.judged, 0, "the classifier never ran");
  assert.equal(observed.bashRuns, 0, "bash never ran");
  assert.equal(observed.isError, false);
  assert.match(observed.text, /real readme content/, "the native read returned the file");
});

test("AgentSession: a schema-valid missing path bypasses bash but still gets the read-path repair", async () => {
  const observed = await runRead(
    { path: "src/confg.ts" },
    async (root) => {
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "config.ts"), "port = 8080\n");
    },
    { readPathRepair: true },
  );

  assert.equal(observed.judged, 0, "a missing path is a normal read call, never classified");
  assert.equal(observed.bashRuns, 0);
  assert.equal(observed.readPathCalls, 1, "the read-path repair still runs");
  assert.equal(observed.restored, 1, "and is recorded as an input repair");
  assert.equal(observed.isError, false, "the repaired read succeeds natively");
  assert.match(observed.text, /port = 8080/);
});

test("AgentSession: a schema-valid missing path without repair still fails natively", async () => {
  const observed = await runRead({ path: "src/confg.ts" }, async (root) => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "config.ts"), "port = 8080\n");
  });

  assert.equal(observed.judged, 0);
  assert.equal(observed.bashRuns, 0);
  assert.equal(observed.readPathCalls, 0, "no repair client is configured");
  assert.equal(observed.isError, true, "the native failure stands");
  assert.match(observed.text, /ENOENT/);
});
