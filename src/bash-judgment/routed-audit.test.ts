/**
 * TASK-0038 — composition-root audit assertions.
 *
 * A classified route must produce ONE `route-to-bash` repair everywhere:
 * one stats count, one event, `classified: true`. A deterministic (exact)
 * route keeps the same single repair and never classifies.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionHost } from "../infra/pi/contracts.ts";

interface Captured {
  handlers: Record<string, (event: any, ctx: any) => Promise<unknown> | unknown>;
  commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  tools: Array<{ name: string; prepareArguments?: (args: unknown) => unknown; execute: (...args: any[]) => Promise<any> }>;
}

/**
 * The composition root reads the developer's real `~/.pi/agent/welder.json`, so
 * these tests run against a throwaway HOME with routing explicitly enabled.
 * They must never depend on local settings.
 */
interface WelderSettings { repairsEnabled?: boolean; commandReroutingEnabled?: boolean }

let tempHome: string | undefined;
let importCount = 0;

/** Writes the settings this test file controls, never the developer's real ones. */
async function writeSettings(home: string, settings: WelderSettings): Promise<void> {
  const agentDir = path.join(home, ".pi", "agent");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(path.join(agentDir, "welder.json"), JSON.stringify(settings));
}

/**
 * Loads and invokes the composition root while HOME points at a throwaway
 * directory. The config path is captured at import and the config is read when
 * the factory runs, so HOME stays active for both and the developer's real
 * `~/.pi/agent/welder.json` can never influence the outcome.
 */
async function loadExtension(settings: WelderSettings = { repairsEnabled: true, commandReroutingEnabled: true }, options: { fresh?: boolean } = {}): Promise<Captured> {
  tempHome ??= await fs.mkdtemp(path.join(os.tmpdir(), "welder-home-"));
  await writeSettings(tempHome, settings);

  const captured: Captured = { handlers: {}, commands: {}, tools: [] };
  const api = {
    on(event: string, handler: any) { captured.handlers[event] = handler; },
    registerCommand(name: string, def: any) { captured.commands[name] = def; },
    registerTool(tool: any) { captured.tools.push(tool); },
  };

  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;
  try {
    const url = options.fresh === true ? `../index.ts?instance=${++importCount}` : "../index.ts";
    const module = await import(url);
    (module.default as (pi: ExtensionHost) => void)(api as any);
  } finally {
    process.env.HOME = previousHome;
  }
  return captured;
}

function context(cwd: string, notifies: Array<[string, string]> = []): any {
  return {
    hasUI: true,
    cwd,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "audit-session" },
    model: { provider: "test-provider", id: "test-model" },
    ui: {
      notify: (message: string, kind: string) => { notifies.push([message, kind]); },
      setStatus: () => { /* status text is asserted elsewhere */ },
    },
  };
}

async function findLogLines(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => path.join(entry.parentPath ?? root, entry.name));
  const lines: string[] = [];
  for (const file of files) {
    lines.push(...(await fs.readFile(file, "utf8")).split("\n").filter((line) => line.trim() !== ""));
  }
  return lines;
}

async function withExtension(
  route: Record<string, unknown>,
  run: (result: { events: any[]; lines: string[]; fetchCalls: number; stats: string }) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "welder-audit-"));
  const previousKey = process.env.TYPESAFE_API_KEY;
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  process.env.TYPESAFE_API_KEY = "test-key";
  globalThis.fetch = (async () => {
    fetchCalls++;
    return { ok: true, status: 200, json: async () => ({ answers: { bash: { choice: "bash" } } }) };
  }) as unknown as typeof fetch;

  try {
    const captured = await loadExtension();
    const write = captured.tools.find((tool) => tool.name === "write");
    assert.ok(write, "the write tool is registered");

    // The sentinel creation is trust-gated, as in a real session.
    await captured.handlers["session_start"]?.(undefined, context(root));

    await write.execute("c1", write.prepareArguments!(route), undefined, undefined, context(root));

    const lines = await findLogLines(root);
    const notifies: Array<[string, string]> = [];
    const statsName = Object.keys(captured.commands).find((name) => name.endsWith("welder-stats"));
    assert.ok(statsName, `the stats command is registered: ${Object.keys(captured.commands).join(", ")}`);
    await captured.commands[statsName]!.handler("", context(root, notifies));

    await run({ events: lines.map((line) => JSON.parse(line)), lines, fetchCalls, stats: notifies.map(([message]) => message).join("\n") });
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

test("a classified route records one repair, one count, and one classified event", async () => {
  await withExtension({ CMD: "printf jev-audit" }, async ({ events, lines, fetchCalls, stats }) => {
    assert.equal(fetchCalls, 1, "the classifier ran once");

    const routed = events.filter((event) => event.targetTool === "bash");
    assert.equal(routed.length, 1, "exactly one routed audit event");
    assert.deepEqual(routed[0].repairs, ["route-to-bash"], "exactly one repair action");
    assert.equal(routed[0].classified, true, "classification is flagged separately");
    assert.equal(routed[0].toolName, "write");
    assert.deepEqual(routed[0].inputKeys, [], "no argument content is logged");
    assert.equal(lines.some((line) => line.includes("jev-audit")), false, "no command text anywhere in the log");

    assert.match(stats, /route-to-bash\s+1\s+100%/, "the repair is counted exactly once");
    assert.equal(/route-to-bash\s+2\b/.test(stats), false, "no duplicate count");
  });
});

test("a deterministic exact route keeps one repair and never classifies", async () => {
  await withExtension({ command: "printf jev-audit", timeout: 20 }, async ({ events, fetchCalls, stats }) => {
    assert.equal(fetchCalls, 0, "the exact shape never calls the classifier");

    const routed = events.filter((event) => event.targetTool === "bash");
    assert.equal(routed.length, 1);
    assert.deepEqual(routed[0].repairs, ["route-to-bash"], "the same single repair");
    assert.equal("classified" in routed[0], false, "no classification flag on a deterministic route");
    assert.match(stats, /route-to-bash\s+1\s+100%/, "still one count");
  });
});

test("the composition root reads settings from HOME, so a developer's real config cannot leak in", async () => {
  // A fresh instance under HOME settings that DISABLE routing. If the developer's
  // real ~/.pi/agent/welder.json were read instead, this call would be routed and
  // the assertion below would fail.
  const disabled = await loadExtension({ repairsEnabled: true, commandReroutingEnabled: false }, { fresh: true });
  const disabledWrite = disabled.tools.find((tool) => tool.name === "write");
  assert.ok(disabledWrite, "the write tool is registered");
  // Trust is set, so the setting alone decides.
  await disabled.handlers["session_start"]?.(undefined, context(process.cwd()));

  const routed = disabledWrite.prepareArguments!({ CMD: "printf jev-isolation" });
  assert.deepEqual(routed, { CMD: "printf jev-isolation" }, "routing stays off when THIS HOME says so");

  // The same call IS routed when THIS HOME enables it: the file drives behavior.
  const enabled = await loadExtension({ repairsEnabled: true, commandReroutingEnabled: true }, { fresh: true });
  const enabledWrite = enabled.tools.find((tool) => tool.name === "write");
  assert.ok(enabledWrite);
  await enabled.handlers["session_start"]?.(undefined, context(process.cwd()));
  const sentinel = enabledWrite.prepareArguments!({ CMD: "printf jev-isolation" }) as { path?: string };
  assert.equal(typeof sentinel.path, "string", "the HOME settings enable routing");
});
