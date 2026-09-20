/**
 * TASK-0039 — real AgentSession tests for read-path repair.
 *
 * A real pi session runs a real `read` tool call through the real welder
 * handlers: the only stand-in is the Jev client. Enabled means the explicit
 * setting plus an available client, with no hidden runtime gate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createAgentSession, DefaultResourceLoader, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { handleToolCall, handleToolResult } from "../handlers.ts";
import { createRuntime, type WelderRuntime } from "../runtime.ts";

async function loadPiAi(): Promise<any> {
  const parent = import.meta.resolve("@earendil-works/pi-coding-agent");
  return import(import.meta.resolve("@earendil-works/pi-ai", parent));
}

interface Scenario {
  /** Omit to model "no API key": the capability never exists. */
  client?: { choose: (request: any, signal?: AbortSignal) => Promise<unknown> };
  enabled?: boolean;
  seed?: (root: string) => Promise<void>;
}

interface Observed {
  text: string;
  isError: boolean;
  calls: number;
  runtime: WelderRuntime;
  logLines: string[];
}

async function runReadSession(scenario: Scenario): Promise<Observed> {
  const ai = await loadPiAi();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "welder-readpath-"));
  const agentDir = path.join(root, ".agent");
  await fs.mkdir(agentDir, { recursive: true });
  await scenario.seed?.(root);

  const faux = ai.createFauxCore({ provider: "faux-welder", models: [{ id: "faux-1" }] });
  faux.setResponses([
    ai.fauxAssistantMessage(ai.fauxToolCall("read", { path: "src/confg.ts" })),
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

  let calls = 0;
  const client = scenario.client === undefined ? undefined : {
    choose: (request: any, signal?: AbortSignal) => { calls++; return scenario.client!.choose(request, signal); },
  };
  const runtime = createRuntime({
    readPathRepairEnabled: scenario.enabled ?? true,
    ...(client === undefined ? {} : { readPathClient: client as never }),
  });

  const extension = {
    name: "welder-readpath-test",
    factory: (pi: any) => {
      pi.on("tool_call", async (event: any, context: any) => { await handleToolCall(runtime, event, context); });
      pi.on("tool_result", async (event: any, context: any) => { await handleToolResult(runtime, event, context); });
    },
  };
  const resourceLoader = new DefaultResourceLoader({
    cwd: root, agentDir, extensionFactories: [extension as never],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });

  // Runtime option: inline factories are only materialized when asked for.
  await resourceLoader.reload({ includeInlineFactories: true } as never);
  const { session } = await createAgentSession({
    cwd: root, agentDir, modelRuntime, model: faux.getModel(), tools: ["read"], resourceLoader,
  });

  try {
    await session.prompt("read the file");
    const messages = session.messages as unknown as Array<{ role: string; content?: unknown[]; isError?: boolean }>;
    const result = messages.filter((message) => message.role === "toolResult")[0];

    const logLines = await findLogLines(root);
    return {
      text: Array.isArray(result?.content) ? result.content.map((block: any) => block?.text ?? "").join("\n") : "",
      isError: result?.isError === true,
      calls,
      runtime,
      logLines,
    };
  } finally {
    session.dispose?.();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** Only the welder log: Pi's own session file legitimately holds tool output. */
async function findLogLines(root: string): Promise<string[]> {
  const directory = path.join(root, ".pi", "welder-log");
  const names = await fs.readdir(directory).catch(() => [] as string[]);
  const lines: string[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".jsonl"))) {
    lines.push(...(await fs.readFile(path.join(directory, name), "utf8")).split("\n").filter((line) => line.trim() !== ""));
  }
  return lines;
}

const seedRealFile = async (root: string) => {
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "config.ts"), "port = 8080\n");
};

test("AgentSession: a validated selection rewrites read.path and the read succeeds", async () => {
  const observed = await runReadSession({
    seed: seedRealFile,
    client: { choose: async () => ({ choice: 1, confidence: 0.99 }) },
  });

  assert.equal(observed.calls, 1, "one bounded request, zero retries");
  assert.equal(observed.isError, false, "the repaired read succeeds");
  assert.match(observed.text, /port = 8080/);
  assert.equal(observed.runtime.stats.repairsByAction.get("restore-read-path"), 1);
  assert.equal(observed.runtime.stats.repairedToolCalls, 1, "an input transformation IS a repair");
  assert.equal(observed.runtime.readPathState.selected, 1);
  assert.equal(observed.runtime.readPathState.abstained, 0);
});

test("AgentSession: the selected path never appears in the log", async () => {
  const observed = await runReadSession({
    seed: seedRealFile,
    client: { choose: async () => ({ choice: 1, confidence: 0.99 }) },
  });

  const log = observed.logLines.join("\n");
  assert.ok(log.includes("restore-read-path"), "the repair signal is recorded");
  assert.equal(log.includes("config.ts"), false, "no candidate path text");
  assert.equal(log.includes("confg.ts"), false, "no requested path text");
  assert.equal(log.includes("port = 8080"), false, "no file content");
});

test("AgentSession: abstain, low confidence, failure, and invalid ordinals leave the call untouched", async () => {
  const scenarios: Array<[string, () => Promise<unknown>]> = [
    ["abstain", async () => ({ choice: null, confidence: 0.5 })],
    ["low confidence", async () => ({ choice: 1, confidence: 0.4 })],
    ["invalid ordinal", async () => ({ choice: 9, confidence: 0.99 })],
    ["rate limit", async () => { throw Object.assign(new Error("429"), { kind: "rate-limited" }); }],
    ["transport failure", async () => { throw new Error("boom"); }],
  ];

  for (const [label, choose] of scenarios) {
    const observed = await runReadSession({ seed: seedRealFile, client: { choose } });

    assert.equal(observed.runtime.stats.repairsByAction.get("restore-read-path"), undefined, label);
    assert.equal(observed.isError, true, `${label}: the original failure stands`);
    assert.equal(observed.text.includes("port = 8080"), false, label);
  }
});

test("AgentSession: the postcheck rejects a selected candidate that no longer resolves", async () => {
  let root = "";
  const observed = await runReadSession({
    seed: async (directory) => {
      root = directory;
      await fs.mkdir(path.join(root, "src"), { recursive: true });
      await fs.writeFile(path.join(root, "src", "config.ts"), "port = 8080\n");
    },
    // The candidate disappears between selection and validation: the postcheck must refuse.
    client: {
      choose: async () => {
        await fs.rm(path.join(root, "src", "config.ts"));
        return { choice: 1, confidence: 0.99 };
      },
    },
  });

  assert.equal(observed.runtime.readPathState.selected, 1, "selection succeeded");
  assert.equal(observed.runtime.stats.repairsByAction.get("restore-read-path"), undefined, "no mutation after a failed postcheck");
  assert.equal(observed.isError, true, "the original failure stands");
});

test("AgentSession: a disabled setting never calls the client or mutates", async () => {
  const observed = await runReadSession({
    seed: seedRealFile,
    enabled: false,
    client: { choose: async () => { throw new Error("must not be called"); } },
  });

  assert.equal(observed.calls, 0, "no API call when the setting is off");
  assert.equal(observed.runtime.stats.repairsByAction.get("restore-read-path"), undefined);
  assert.equal(observed.isError, true);
});

test("AgentSession: no client means no capability, so nothing is planned or called", async () => {
  const observed = await runReadSession({ seed: seedRealFile, enabled: true });

  assert.equal(observed.calls, 0);
  assert.equal(observed.runtime.readPathState.eligible, 0, "no client, no plan");
  assert.equal(observed.isError, true);
});
