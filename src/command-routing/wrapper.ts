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

export const ROUTE_SENTINEL_PREFIX = "pi-welder-route:";
/** Bounded: a stale token must never accumulate or leak across sessions. */
export const MAX_ROUTE_TOKENS = 32;

export type RouteToolName = "read" | "write" | "edit";

export interface StoredRouteCommand {
  command: string;
  timeout?: number;
}

export interface BashRouteState {
  /** Opt-in setting, read live so a settings change takes effect immediately. */
  isEnabled: () => boolean;
  /** Project trust known before execute (execute re-checks ctx as well). */
  isTrusted: () => boolean;
  tokens: Map<string, StoredRouteCommand>;
}

export function createBashRouteState(options: { isEnabled?: () => boolean; isTrusted?: () => boolean } = {}): BashRouteState {
  return {
    isEnabled: options.isEnabled ?? (() => false),
    isTrusted: options.isTrusted ?? (() => false),
    tokens: new Map(),
  };
}

export function clearBashRouteTokens(state: BashRouteState): void {
  state.tokens.clear();
}

function rememberToken(state: BashRouteState, token: string, command: StoredRouteCommand): void {
  state.tokens.set(token, command);
  while (state.tokens.size > MAX_ROUTE_TOKENS) {
    const oldest = state.tokens.keys().next();
    if (oldest.done === true) break;
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
      if (!call) return prepared;
      const token = nextToken();
      rememberToken(state, token, { command: call.command, ...(call.timeout === undefined ? {} : { timeout: call.timeout }) });
      return sentinelArguments(toolName, token);
    },

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const token = sentinelTokenOf(params);
      const stored = token === undefined ? undefined : state.tokens.get(token);
      if (stored !== undefined && token !== undefined) {
        // One use only: consume before doing anything observable.
        state.tokens.delete(token);
        if (ctx?.isProjectTrusted?.() !== true) return refusedResult(toolName);
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
            details: result.details ?? {},
            ...(result.isError === true ? { isError: true } : {}),
          };
        } catch (error) {
          // Never claim success when the bash capability fails.
          options.onDelegateError?.(error);
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text", text: `pi-welder: bash execution failed. ${message}` }], details: {}, isError: true };
        }
      }
      // Unknown or absent token: normal call, delegate to the built-in for cwd.
      return resolveBuiltin(typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd()).execute(toolCallId, params, signal, onUpdate, ctx);
    },

    renderCall: (args, theme, context) => {
      if (sentinelTokenOf(args) !== undefined) return noticeComponent([`bash (routed ${toolName}) — command hidden`]);
      const resolved = resolveBuiltin(context?.cwd ?? process.cwd());
      return resolved.renderCall?.(args, theme, context) ?? noticeComponent([toolName]);
    },

    renderResult: (result, renderOptions, theme, context) => {
      if (sentinelTokenOf(context?.args) !== undefined) {
        const status = context?.isError === true || result?.isError === true ? "failed" : "completed";
        const preview = textOf(result).split("\n").slice(0, 5);
        return noticeComponent([`bash (routed ${toolName}) — ${status}`, ...preview]);
      }
      const resolved = resolveBuiltin(context?.cwd ?? process.cwd());
      return resolved.renderResult?.(result, renderOptions, theme, context) ?? noticeComponent([toolName]);
    },
  };
}

/** Refused routed call: no execution, no command, and never a success claim. */
export function refusedResult(toolName: RouteToolName): { content: { type: "text"; text: string }[]; details: Record<string, unknown>; isError: true } {
  return {
    content: [{ type: "text", text: `pi-welder: refused to execute this ${toolName} call because the project is not trusted.` }],
    details: {},
    isError: true,
  };
}
