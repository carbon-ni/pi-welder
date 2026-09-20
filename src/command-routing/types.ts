/**
 * TASK-0034 — types for exact bash-shaped wrong-tool execution.
 *
 * A routed call is executed once through an injected bash capability. The
 * command is never logged, never rewritten, and never echoed in the reason.
 */

export interface BashExecutionOutcome {
  /** Output the bash tool produced, or its error message. Never the command. */
  text: string;
  /** Bash tool details (truncation metadata) when available. */
  details?: unknown;
  /** True when the command failed (non-zero exit, timeout, abort) or errored. */
  isError: boolean;
}

export interface BashExecutionRequest {
  toolCallId: string;
  command: string;
  timeout?: number;
  cwd: string;
  signal?: AbortSignal;
}

/**
 * Injected capability. The composition root wraps Pi's built-in bash tool; the
 * router never spawns a shell itself.
 */
export interface BashExecutor {
  execute(request: BashExecutionRequest): Promise<BashExecutionOutcome>;
}

export interface BashRouteResult {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError: boolean;
}

export interface PendingBashRoute {
  toolCallId: string;
  sourceTool: string;
  outcome: BashExecutionOutcome;
  /** True when the block reason already carried the outcome. */
  delivered: boolean;
}

/** Bounded: routed calls are rare, and stale entries must not accumulate. */
export const MAX_PENDING_BASH_ROUTES = 32;

export function createPendingBashRoutes(): Map<string, PendingBashRoute> {
  return new Map();
}

export function rememberPendingBashRoute(routes: Map<string, PendingBashRoute>, route: PendingBashRoute): void {
  routes.set(route.toolCallId, route);
  while (routes.size > MAX_PENDING_BASH_ROUTES) {
    const oldest = routes.keys().next();
    if (oldest.done === true) break;
    routes.delete(oldest.value);
  }
}

export function consumePendingBashRoute(routes: Map<string, PendingBashRoute>, toolCallId: string | undefined): PendingBashRoute | undefined {
  if (toolCallId === undefined) return undefined;
  const route = routes.get(toolCallId);
  if (route === undefined) return undefined;
  routes.delete(toolCallId);
  return route;
}

export function clearPendingBashRoutes(routes: Map<string, PendingBashRoute>): void {
  routes.clear();
}

/** Result patch for a consumed route: the real bash content/outcome. */
export function toBashRouteResult(route: PendingBashRoute): BashRouteResult {
  return {
    content: [{ type: "text", text: route.outcome.text }],
    details: (route.outcome.details && typeof route.outcome.details === "object" ? route.outcome.details : {}) as Record<string, unknown>,
    isError: route.outcome.isError,
  };
}
