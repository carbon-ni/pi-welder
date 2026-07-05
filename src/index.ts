/**
 * Welder — failure registry extension.
 *
 * Hooks `tool_result`, classifies harness-level failures (excluding CLI bash
 * exits), stores them in the session via `pi.appendEntry`, and exposes a
 * `/failures` command to view them.
 *
 * Load with:  pi -e ./src/index.ts
 * (or via .pi/extensions/welder.ts re-export for auto-discovery)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  classifyFailure,
  emptyLog,
  recordFailure,
  summarize,
  type FailureLog,
  type ToolResultInput,
} from "./failure-log.ts";

const STATE_KEY = "welder-failures";

export default function welder(pi: ExtensionAPI) {
  let log: FailureLog = emptyLog();

  // Rebuild in-memory state from the current session branch on start / nav.
  function restore(ctx: { sessionManager: { getBranch(): Array<any> } }) {
    log = emptyLog();
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry?.type === "custom" && entry.customType === STATE_KEY) {
        const data = entry.data as FailureLog | undefined;
        if (data?.failures && typeof data.nextId === "number") {
          log = data;
        }
      }
    }
  }

  function persist(pi: ExtensionAPI) {
    pi.appendEntry<FailureLog>(STATE_KEY, log);
  }

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
  });

  // The registry hook: classify, record, persist.
  pi.on("tool_result", async (event, _ctx) => {
    const input: ToolResultInput = {
      toolName: event.toolName,
      isError: Boolean(event.isError),
      details: (event as { details?: unknown }).details,
      content: (event.content ?? []) as ToolResultInput["content"],
    };
    const classified = classifyFailure(input);
    if (!classified) return;

    log = recordFailure(log, {
      kind: classified.kind,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      cwd: _ctx.cwd,
      input: event.input,
      errorContent: input.content
        .map((c) => (c.type === "text" && c.text ? c.text : ""))
        .join(" "),
    });
    persist(pi);
    _ctx.ui.notify(`failure #${log.nextId - 1} [${classified.kind}]: ${event.toolName}`, "info");
  });

  pi.registerCommand("failures", {
    description: "Show registered harness failures",
    handler: async (_args, ctx) => {
      ctx.ui.notify(summarize(log), "info");
    },
  });
}
