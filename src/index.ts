/**
 * Welder — model tool-call mistake telemetry extension.
 *
 * Goal: understand where models make tool-call mistakes most often so we can
 * target future repair rules. Logging is only one collection mechanism.
 *
 * Current signals:
 *   - tool_call: schema/syntax-shaped mistakes before tools execute
 *   - tool_result: harness-side errors after execution, excluding CLI bash exits
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
  type ToolResultInput as FailureToolResultInput,
} from "./failure-log.ts";
import {
  collectToolCallMistakes,
  collectToolResultMistake,
  emptyTelemetry,
  recordMistake,
  summarizeTelemetry,
  type ToolMistakeTelemetry,
  type ToolResultInput as MistakeToolResultInput,
} from "./tool-mistakes.ts";

const FAILURE_STATE_KEY = "welder-failures";
const TELEMETRY_STATE_KEY = "welder-tool-mistakes";

export default function welder(pi: ExtensionAPI) {
  let failureLog: FailureLog = emptyLog();
  let telemetry: ToolMistakeTelemetry = emptyTelemetry();

  // Rebuild in-memory state from the current session branch on start / nav.
  function restore(ctx: { sessionManager: { getBranch(): Array<any> } }) {
    failureLog = emptyLog();
    telemetry = emptyTelemetry();

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry?.type !== "custom") continue;

      if (entry.customType === FAILURE_STATE_KEY) {
        const data = entry.data as FailureLog | undefined;
        if (data?.failures && typeof data.nextId === "number") failureLog = data;
      }

      if (entry.customType === TELEMETRY_STATE_KEY) {
        const data = entry.data as ToolMistakeTelemetry | undefined;
        if (data?.records && typeof data.nextId === "number") telemetry = data;
      }
    }
  }

  function persistFailures(pi: ExtensionAPI) {
    pi.appendEntry<FailureLog>(FAILURE_STATE_KEY, failureLog);
  }

  function persistTelemetry(pi: ExtensionAPI) {
    pi.appendEntry<ToolMistakeTelemetry>(TELEMETRY_STATE_KEY, telemetry);
  }

  function modelId(ctx: { model?: { id?: string } }): string | undefined {
    try {
      return ctx.model?.id;
    } catch {
      return undefined;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    restore(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restore(ctx);
  });

  // Pre-execution telemetry: patterns like aliased fields, null optionals,
  // stringified arrays. This is the main signal for future repair rules.
  pi.on("tool_call", async (event, ctx) => {
    const drafts = collectToolCallMistakes({
      toolName: event.toolName,
      input: (event as { input?: unknown }).input,
    });
    if (drafts.length === 0) return;

    for (const draft of drafts) {
      telemetry = recordMistake(telemetry, {
        ...draft,
        toolCallId: event.toolCallId,
        cwd: ctx.cwd,
        modelId: modelId(ctx),
      });
    }

    persistTelemetry(pi);
    ctx.ui.notify(`recorded ${drafts.length} tool-call mistake(s) for ${event.toolName}`, "info");
  });

  // Post-execution telemetry + legacy failure registry. Tool result errors are
  // secondary signals, useful for harness errors that escaped preflight.
  pi.on("tool_result", async (event, ctx) => {
    const resultInput: MistakeToolResultInput = {
      toolName: event.toolName,
      isError: Boolean(event.isError),
      details: (event as { details?: unknown }).details,
      content: (event.content ?? []) as MistakeToolResultInput["content"],
    };

    const mistake = collectToolResultMistake(resultInput);
    if (mistake) {
      telemetry = recordMistake(telemetry, {
        ...mistake,
        toolCallId: event.toolCallId,
        cwd: ctx.cwd,
        input: event.input,
        modelId: modelId(ctx),
      });
      persistTelemetry(pi);
    }

    // Keep previous /failures behavior intact for now.
    const failureInput: FailureToolResultInput = resultInput;
    const classified = classifyFailure(failureInput);
    if (!classified) return;

    failureLog = recordFailure(failureLog, {
      kind: classified.kind,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      cwd: ctx.cwd,
      input: event.input,
      errorContent: resultInput.content
        .map((c) => (c.type === "text" && c.text ? c.text : ""))
        .join(" "),
    });
    persistFailures(pi);
    ctx.ui.notify(`failure #${failureLog.nextId - 1} [${classified.kind}]: ${event.toolName}`, "info");
  });

  pi.registerCommand("mistakes", {
    description: "Show model tool-call mistake telemetry hotspots",
    handler: async (_args, ctx) => {
      ctx.ui.notify(summarizeTelemetry(telemetry), "info");
    },
  });

  pi.registerCommand("failures", {
    description: "Show registered harness failures (legacy view)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(summarize(failureLog), "info");
    },
  });
}
