/**
 * TASK-0037 — real AgentSession lifecycle test on the installed SDK.
 *
 * Uses the public `DefaultResourceLoader({ extensionFactories })` seam so the
 * collector receives genuine `tool_execution_start`/`tool_execution_end` events
 * from a real session, and pi-ai's public faux provider to script the assistant
 * tool calls (no network, no API key).
 *
 * The built-in `write` tool is enabled so Pi itself produces the anchored
 * validation failure; `bash` is enabled so the corrected call can succeed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createAgentSession, DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createProspectiveLabelCollector, type LabelRecord } from "./collector.ts";

async function loadPiAi(): Promise<any> {
  const parent = import.meta.resolve("@earendil-works/pi-coding-agent");
  return import(import.meta.resolve("@earendil-works/pi-ai", parent));
}

interface Harness {
  records: LabelRecord[];
  results: Array<{ toolName: string; isError: boolean; text: string }>;
  factoryRan: boolean;
  run(): Promise<void>;
  cleanup(): Promise<void>;
}

async function runLifecycle(options: {
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  enabled?: boolean;
}): Promise<Harness> {
  const ai = await loadPiAi();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "welder-labels-"));
  const agentDir = path.join(root, ".agent");
  await fs.mkdir(agentDir, { recursive: true });

  const faux = ai.createFauxCore({ provider: "faux-labels", models: [{ id: "faux-1" }] });
  faux.setResponses([
    ...options.calls.map((call) => ai.fauxAssistantMessage(ai.fauxToolCall(call.tool, call.args))),
    ai.fauxAssistantMessage(ai.fauxText("done")),
  ]);

  const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: path.join(agentDir, "auth.json") });
  modelRuntime.registerProvider("faux-labels", {
    name: "faux", apiKey: "test", api: faux.api, baseUrl: "http://localhost/v1", streamSimple: faux.streamSimple,
    models: faux.models.map((model: any) => ({
      id: model.id, name: model.name ?? model.id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0 }, contextWindow: 100_000, maxTokens: 4_096,
    })),
  });

  const records: LabelRecord[] = [];
  let factoryRan = false;
  const collector = createProspectiveLabelCollector({
    isEnabled: () => options.enabled ?? true,
    sessionId: () => "session-labels",
  });

  // Public inline-extension seam: the session drives the collector.
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    extensionFactories: [(pi: any) => {
      factoryRan = true;
      // Single persistence owner: the inline extension returns-and-records,
      // mirroring what welder handlers do.
      pi.on("tool_execution_start", (event: any) => { records.push(...collector.onToolStart(event)); });
      pi.on("tool_execution_end", (event: any) => {
        const content = Array.isArray(event.result?.content) ? event.result.content : [];
        const errorText = content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).filter(Boolean).join("\n");
        records.push(...collector.onToolEnd({
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError === true,
          args: (event.result as { args?: unknown } | undefined)?.args,
          ...(errorText ? { errorText } : {}),
        }));
      });
      // No turn_end closure: a correction legitimately arrives in the next turn.
    }],
  });

  // Public example requires the loader to be reloaded before the session is
  // created, otherwise inline extension factories are never invoked.
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    tools: ["write", "bash"],
    resourceLoader: loader,
  });

  const harness = {
    records,
    factoryRan,
    results: [] as Array<{ toolName: string; isError: boolean; text: string }>,
    async run() {
      await session.prompt("run the command");
      this.results = session.messages
        .filter((message: any) => message.role === "toolResult")
        .map((message: any) => ({
          toolName: message.toolName,
          isError: message.isError === true,
          text: Array.isArray(message.content) ? message.content.map((block: any) => (typeof block?.text === "string" ? block.text : "")).join("\n") : "",
        }));
    },
    async cleanup() {
      session.dispose?.();
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    },
  };
  return harness;
}

test("AgentSession lifecycle: the session emits the anchored failure then a successful correction", async () => {
  const harness = await runLifecycle({ calls: [{ tool: "write", args: { execute: "printf ok" } }, { tool: "bash", args: { command: "printf ok" } }] });
  try {
    await harness.run();
    // Facts the collector depends on, proven on the installed 0.83 session:
    // the built-in write rejects the bash shape with the anchored header, and
    // the corrected bash call succeeds.
    assert.equal(harness.results.length, 2);
    assert.equal(harness.results[0]!.toolName, "write");
    assert.equal(harness.results[0]!.isError, true);
    assert.match(harness.results[0]!.text, /^Validation failed for tool "write":/);
    assert.equal(harness.results[1]!.toolName, "bash");
    assert.equal(harness.results[1]!.isError, false);
  } finally {
    await harness.cleanup();
  }
});

test("AgentSession lifecycle: a corrected call that fails is an error result", async () => {
  const harness = await runLifecycle({ calls: [{ tool: "write", args: { execute: "printf ok" } }, { tool: "bash", args: { command: "exit 3" } }] });
  try {
    await harness.run();
    assert.equal(harness.results[1]!.toolName, "bash");
    assert.equal(harness.results[1]!.isError, true, "a failed correction is an error result");
  } finally {
    await harness.cleanup();
  }
});

/**
 * BLOCKED (reported, not simulated): wiring the collector to these genuine
 * events through the public `DefaultResourceLoader({ extensionFactories })`
 * seam does not work on the installed 0.83 dependency — the factory is never
 * invoked (`factoryRan: false`), so no `tool_execution_start`/`tool_execution_end`
 * extension event reaches the collector. The session-level facts above are
 * therefore asserted here, and the collector itself is unit-tested against the
 * documented event shapes.
 */
test("AgentSession lifecycle: the loader reload wires the inline factory and one label is recorded", async () => {
  const harness = await runLifecycle({ calls: [{ tool: "write", args: { execute: "printf ok" } }, { tool: "bash", args: { command: "printf ok" } }] });
  try {
    assert.equal(harness.factoryRan, true, "reload() invokes the inline extension factory");
    await harness.run();
    const labelled = harness.records.filter((record) => record.outcome === "labelled");
    assert.equal(labelled.length, 1, JSON.stringify(harness.records.map((record) => `${record.outcome}:${record.sourceTool}->${record.targetTool}`)));
    assert.equal(labelled[0]!.sourceTool, "write");
    assert.equal(labelled[0]!.targetTool, "bash");
    assert.ok(labelled[0]!.pairs.includes("command<-execute"));
  } finally {
    await harness.cleanup();
  }
});

test("AgentSession lifecycle: a failing corrected call records no label", async () => {
  const harness = await runLifecycle({ calls: [{ tool: "write", args: { execute: "printf ok" } }, { tool: "bash", args: { command: "exit 3" } }] });
  try {
    await harness.run();
    assert.equal(harness.records.filter((record) => record.outcome === "labelled").length, 0);
  } finally {
    await harness.cleanup();
  }
});

test("AgentSession lifecycle: disabled collects nothing even with the factory wired", async () => {
  const harness = await runLifecycle({ calls: [{ tool: "write", args: { execute: "printf ok" } }, { tool: "bash", args: { command: "printf ok" } }], enabled: false });
  try {
    assert.equal(harness.factoryRan, true);
    await harness.run();
    assert.equal(harness.records.length, 0);
  } finally {
    await harness.cleanup();
  }
});
