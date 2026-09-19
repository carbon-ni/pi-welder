/**
 * pi-welder — harness-level repair layer for LLM tool calls.
 *
 * One `tool_call` handler applies a finite set of structural repairs
 * (null-strip, JSON parse, array wrap, type coercion, …) before the tool
 * runs, and blocks read-shaped `edit` calls with the exact corrected `read`
 * call (TASK-0028). Repairs are transparent and content fields are never
 * touched. Every repair is logged to `.pi/welder-log/<sessionId>.jsonl`.
 *
 * Commands: /welder-stats · /welder-reset · /welder-log · /welder-failures · /welder-clear · /welder-settings
 */

import type { ExtensionHost } from "./infra/pi/contracts.ts";
import { registerWelderCommands } from "./commands.ts";
import { loadWelderConfig } from "./config.ts";
import {
  DEFAULT_SESSION_RETENTION,
  handleContext,
  handleSessionShutdown,
  handleSessionStart,
  handleToolCall,
  handleToolResult,
} from "./handlers.ts";
import { createRuntime } from "./runtime.ts";
import { createTypeSafeJevClient } from "./infra/typesafe.ts";
import { READ_PATH_PROMPT } from "./read-recovery/path-repair.ts";

export default function (pi: ExtensionHost) {
  const config = loadWelderConfig();
  // Whitespace-only or absent keys mean no client exists at all.
  const apiKey = process.env.TYPESAFE_API_KEY?.trim() || undefined;
  const runtime = createRuntime({
    ...config,
    // Client exists whenever an API key is present, so the setting can be
    // toggled on live; sourceShadowingEnabled alone controls actual use.
    jevClient: apiKey ? createTypeSafeJevClient({ apiKey }) : undefined,
    // Read-path repair uses its own question/instructions and is gated by the
    // readPathRepairEnabled setting plus the frozen evidence verdict.
    readPathClient: apiKey ? createTypeSafeJevClient({ apiKey, prompt: READ_PATH_PROMPT }) : undefined,
  });

  pi.on("session_start", async (_event, ctx) => handleSessionStart(runtime, ctx, DEFAULT_SESSION_RETENTION));

  pi.on("session_shutdown", async (_event, ctx) => handleSessionShutdown(runtime, ctx));

  pi.on("tool_call", async (event, ctx) => handleToolCall(runtime, event, ctx));

  pi.on("tool_result", async (event, ctx) => handleToolResult(runtime, event, ctx));

  pi.on("context", async (event, ctx) => handleContext(runtime, event, ctx));

  registerWelderCommands(pi, runtime);
}
