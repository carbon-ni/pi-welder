/**
 * TASK-0034 (redesign) — same-name built-in tool wrappers for bash-shaped calls.
 *
 * Pi keeps the tool schema as the single source of truth. The wrapper keeps the
 * built-in `parameters` unchanged and uses `prepareArguments` (which runs before
 * schema validation) to swap an exact bash-shaped call for a schema-valid
 * sentinel that carries only an opaque one-use token. `execute` routes the
 * sentinel to bash, and delegates every other call to the built-in behavior.
 *
 * The token store never holds the token in the sentinel beyond a random string,
 * and the command is never logged, rendered, or copied into any result.
 */

import { recognizeBashShapedCall } from "./gate.ts";
import { BASH_JUDGMENT_MAX_MS, parseBashJudgment, type BashJudgmentClient } from "../bash-judgment/contract.ts";
import { judgeEligibility } from "../bash-judgment/eligibility.ts";

export const ROUTE_SENTINEL_PREFIX = "pi-welder-route:";
/** Bounded count, total payload, and per-command payload. */
export const MAX_ROUTE_TOKENS = 32;
export const MAX_COMMAND_BYTES = 8_192;
export const MAX_TOTAL_COMMAND_BYTES = 32_768;

export type RouteToolName = "read" | "write" | "edit";

export interface StoredRouteCommand {
  /** The wrapper that prepared this token; a mismatch fails closed. */
  sourceTool: RouteToolName;
  /** Set when the token came from Jev-judged non-exact eligibility. */
  judgment?: { key: string };
  /** Policy epoch at preparation time; a bump makes the token unrouteable. */
  epoch: number;
  command: string;
  timeout?: number;
}

function commandBytes(command: string): number {
  return Buffer.byteLength(command, "utf8");
}

function totalCommandBytes(tokens: Map<string, StoredRouteCommand>): number {
  let total = 0;
  for (const stored of tokens.values()) total += commandBytes(stored.command);
  return total;
}

export interface BashRouteState {
  /** Opt-in setting, read live so a settings change takes effect immediately. */
  isEnabled: () => boolean;
  /** Project trust known before execute (execute re-checks ctx as well). */
  isTrusted: () => boolean;
  tokens: Map<string, StoredRouteCommand>;
  /**
   * Monotonic policy epoch. Every transition that can change eligibility bumps
   * it and drops prepared tokens, so off -> on cannot revive a stale token even
   * though the resulting settings tuple is identical.
   */
  epoch: number;
}

export function createBashRouteState(options: { isEnabled?: () => boolean; isTrusted?: () => boolean } = {}): BashRouteState {
  return {
    isEnabled: options.isEnabled ?? (() => false),
    isTrusted: options.isTrusted ?? (() => false),
    tokens: new Map(),
    epoch: 0,
  };
}

export function clearBashRouteTokens(state: BashRouteState): void {
  state.tokens.clear();
}

/**
 * Invalidates every prepared route: bumps the epoch and drops the tokens. Call
 * this on every policy transition (master repairs switch, command-rerouting
 * setting, `route-to-bash` disabled, trust change, session reset).
 */
export function invalidateBashRoutes(state: BashRouteState): void {
  state.epoch++;
  state.tokens.clear();
}

/**
 * Stores a token under both bounds. Eviction is safe: an evicted token can no
 * longer be presented (that path fails closed), so it can never be routed.
 */
function rememberToken(state: BashRouteState, token: string, command: StoredRouteCommand): void {
  state.tokens.set(token, command);
  while (state.tokens.size > MAX_ROUTE_TOKENS || totalCommandBytes(state.tokens) > MAX_TOTAL_COMMAND_BYTES) {
    const oldest = state.tokens.keys().next();
    if (oldest.done === true) break;
    if (oldest.value === token) break; // never evict the token just stored
    state.tokens.delete(oldest.value);
  }
}

/** Schema-valid stand-in for the routed call. Contains no command text. */
export function sentinelArguments(toolName: RouteToolName, token: string): Record<string, unknown> {
  const path = `${ROUTE_SENTINEL_PREFIX}${token}`;
  if (toolName === "write") return { path, content: "" };
  if (toolName === "edit") return { path, edits: [] };
  return { path };
}

/** Token carried by schema-valid sentinel arguments, if any. */
export function sentinelTokenOf(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || Array.isArray(params)) return undefined;
  const path = (params as { path?: unknown }).path;
  if (typeof path !== "string" || !path.startsWith(ROUTE_SENTINEL_PREFIX)) return undefined;
  const token = path.slice(ROUTE_SENTINEL_PREFIX.length);
  return token.length === 0 ? undefined : token;
}

export interface BashDelegateRequest {
  toolCallId: string;
  command: string;
  timeout?: number;
  cwd: string;
  signal?: AbortSignal;
}

export interface BashDelegateResult {
  content: unknown[];
  details?: unknown;
  isError?: boolean;
}

/** Delegates to Pi's built-in bash tool; never spawns a shell itself. */
export type BashDelegate = (request: BashDelegateRequest) => Promise<BashDelegateResult>;

export interface RoutedAudit {
  sourceTool: RouteToolName;
  targetTool: "bash";
  toolCallId: string;
}

/** Minimal structural contracts; the composition root passes real definitions. */
export interface ToolLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  renderShell?: string;
  executionMode?: string;
  prepareArguments?: (args: unknown) => unknown;
  execute: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => Promise<any>;
  renderCall?: (args: any, theme: any, context: any) => { render(width: number): string[]; invalidate(): void };
  renderResult?: (result: any, options: any, theme: any, context: any) => { render(width: number): string[]; invalidate(): void };
}

interface WrapOptions {
  /** TASK-0038 dedicated classifier (see above). */
  judgeBash?: BashJudgmentClient;
  judgmentTimeoutMs?: number;
  builtin: ToolLike;
  toolName: RouteToolName;
  state: BashRouteState;
  delegate: BashDelegate;
  /** Resolves the built-in definition for the current working directory. */
  resolveBuiltin: (cwd: string) => ToolLike;
  /** Injected for deterministic tests. */
  nextToken?: () => string;
  onRouted?: (audit: RoutedAudit, ctx: unknown) => void;
  onDelegateError?: (error: unknown) => void;
}

function noticeComponent(lines: readonly string[]) {
  return {
    render: (_width: number) => [...lines],
    invalidate: () => { /* static notice */ },
  };
}

function textOf(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) return "";
  return result.content
    .map((block) => (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string" ? (block as { text: string }).text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

/**
 * Wraps one built-in tool definition. The returned object keeps the built-in
 * name, schema, label, description, prompt metadata, and rendering for normal
 * calls; only an exact bash-shaped call takes the routed path.
 */
export function wrapToolForBashRouting(options: WrapOptions): ToolLike {
  const { builtin, toolName, state, delegate, resolveBuiltin, onRouted } = options;
  const nextToken = options.nextToken ?? (() => globalThis.crypto.randomUUID().replaceAll("-", ""));
  const builtinPrepare = builtin.prepareArguments;

  return {
    ...builtin,
    name: builtin.name,
    label: builtin.label,
    description: builtin.description,
    parameters: builtin.parameters,

    prepareArguments: (args: unknown): unknown => {
      const prepared = builtinPrepare ? builtinPrepare(args) : args;
      if (!state.isEnabled() || !state.isTrusted()) return prepared;
      const call = recognizeBashShapedCall(toolName, args);
      if (!call) {
        // TASK-0038: non-exact shape, classified before any execution.
        if (options.judgeBash === undefined) return prepared;
        const eligibility = judgeEligibility(args);
        if (!eligibility.eligible || eligibility.candidate === undefined) return prepared;
        const judgedToken = nextToken();
        rememberToken(state, judgedToken, {
          sourceTool: toolName,
          epoch: state.epoch,
          command: eligibility.candidate.candidate,
          ...(eligibility.candidate.timeout === undefined ? {} : { timeout: eligibility.candidate.timeout }),
          judgment: { key: eligibility.candidate.key },
        });
        return sentinelArguments(toolName, judgedToken);
      }
      // Oversized commands stay native: no token, no routing.
      if (commandBytes(call.command) > MAX_COMMAND_BYTES) return prepared;
      const token = nextToken();
      rememberToken(state, token, { sourceTool: toolName, epoch: state.epoch, command: call.command, ...(call.timeout === undefined ? {} : { timeout: call.timeout }) });
      return sentinelArguments(toolName, token);
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const token = sentinelTokenOf(params);
      if (token !== undefined) {
        // A sentinel-looking call is never a normal call: it either routes or
        // fails closed. It must never reach read/write/edit.
        const stored = state.tokens.get(token);
        if (stored !== undefined) state.tokens.delete(token); // one use, always
        if (!state.isEnabled()) throwRouteRefusal(toolName, "routing disabled");
        if (stored === undefined) throwRouteRefusal(toolName, "unknown or expired token");
        if (stored.epoch !== state.epoch) throwRouteRefusal(toolName, "token expired by a policy change");
        if (stored.sourceTool !== toolName) throwRouteRefusal(toolName, "token belongs to another tool");
        if (stored.judgment !== undefined) {
          // Live recheck happens before the model call and again before execution.
          if (signal?.aborted === true) throwRouteRefusal(toolName, "aborted before classification");
          if (ctx?.isProjectTrusted?.() !== true) throwRouteRefusal(toolName, "untrusted project");
          const verdict = await judgeWithDeadline(options, {
            attemptedTool: toolName,
            key: stored.judgment.key,
            candidate: stored.command,
          }, signal);
          if (verdict !== "bash") throwRouteRefusal(toolName, "classified as not-bash");
        }
        if (ctx?.isProjectTrusted?.() !== true) throwRouteRefusal(toolName, "untrusted project");
        onRouted?.({ sourceTool: toolName, targetTool: "bash", toolCallId }, ctx);
        try {
          const result = await delegate({
            toolCallId,
            command: stored.command,
            ...(stored.timeout === undefined ? {} : { timeout: stored.timeout }),
            cwd: typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd(),
            ...(signal === undefined ? {} : { signal }),
          });
          return {
            content: result.content,
            ...(result.details === undefined ? {} : { details: result.details }),
            ...(result.isError === true ? { isError: true } : {}),
          };
        } catch (error) {
          // Pi derives isError from a throw: never claim success on failure.
          options.onDelegateError?.(error);
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`pi-welder: bash execution failed. ${message}`);
        }
      }
      // Normal call: no sentinel anywhere, so delegate to the built-in for cwd.
      return resolveBuiltin(typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd()).execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall: (args, theme, context) => {
      if (isRoutedRenderArgs(args)) return noticeComponent([`bash (routed ${toolName}) — command hidden`]);
      const resolved = resolveBuiltin(context?.cwd ?? process.cwd());
      return resolved.renderCall?.(args, theme, context) ?? noticeComponent([toolName]);
    },

    renderResult: (result, renderOptions, theme, context) => {
      if (isRoutedRenderArgs(context?.args)) {
        const status = context?.isError === true || result?.isError === true ? "failed" : "completed";
        const preview = textOf(result).split("\n").slice(0, 5);
        return noticeComponent([`bash (routed ${toolName}) — ${status}`, ...preview]);
      }
      const resolved = resolveBuiltin(context?.cwd ?? process.cwd());
      return resolved.renderResult?.(result, renderOptions, theme, context) ?? noticeComponent([toolName]);
    },
  };
}

/**
 * Runs the dedicated classifier with a strict deadline and zero retry. Any
 * failure — malformed answer, unavailable client, timeout, or abort — returns
 * `not-bash`, so the caller fails closed and never executes.
 */
async function judgeWithDeadline(
  options: WrapOptions,
  request: { attemptedTool: string; key: string; candidate: string },
  signal: AbortSignal | undefined,
): Promise<"bash" | "not-bash"> {
  const client = options.judgeBash;
  if (client === undefined) return "not-bash";
  const timeoutMs = options.judgmentTimeoutMs ?? BASH_JUDGMENT_MAX_MS;
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  try {
    const raw = await client.judge(request, combined);
    return parseBashJudgment(raw)?.verdict ?? "not-bash";
  } catch {
    return "not-bash";
  }
}

/**
 * Routed-call rendering predicate. Pi's renderers can receive the ORIGINAL
 * assistant arguments instead of the prepared sentinel, so a missing `command`
 * string also counts as routed. A legitimate read/write/edit call never has a
 * `command` key (the strict schemas forbid it).
 */
export function isRoutedRenderArgs(args: unknown): boolean {
  if (sentinelTokenOf(args) !== undefined) return true;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  return typeof (args as { command?: unknown }).command === "string";
}

/** Bounded refusal message; never contains a command. */
export function routeRefusalMessage(toolName: RouteToolName, reason = "refused"): string {
  return `pi-welder: refused to route this ${toolName} call (${reason}); the original call was not executed.`;
}

/**
 * Fails a routed call closed. Throwing is the host contract for a failed tool:
 * Pi turns a thrown execute error into an error tool result, so the call can
 * never be mistaken for a success and never reaches read/write/edit.
 */
export function throwRouteRefusal(toolName: RouteToolName, reason = "refused"): never {
  throw new Error(routeRefusalMessage(toolName, reason));
}
