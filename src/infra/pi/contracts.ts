export interface WelderComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

export interface WelderUi {
  notify(message: string, kind?: "info" | "warn" | "error"): void;
  setStatus(key: string, value: string | undefined): void;
  /** Render a custom keyboard-focused component (TUI only). Adapter-owned. */
  custom?<T>(
    factory: (
      tui: unknown,
      theme: unknown,
      keybindings: unknown,
      done: (result: T) => void,
    ) => WelderComponent & { dispose?(): void },
  ): Promise<T>;
}

export interface WelderContext {
  hasUI: boolean;
  /** Pi mode: "tui" | "rpc" | "json". Settings UI requires "tui". */
  mode?: string;
  cwd: string;
  /** Pi project trust for the current working directory. Missing means untrusted. */
  isProjectTrusted?: () => boolean;
  /** Current turn abort signal, forwarded to nested execution. */
  signal?: AbortSignal;
  model?: { provider?: string; id?: string };
  sessionManager?: { getSessionId?: () => string };
  ui: WelderUi;
}

export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent {
  toolName: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  isError?: boolean;
  content?: unknown;
}

export interface ContextEvent {
  messages: unknown[];
}

export interface CommandRegistrar {
  registerCommand(name: string, definition: {
    description: string;
    handler: (args: string, context: WelderContext) => Promise<void> | void;
  }): void;
}

export interface ToolExecutionStartEvent { toolCallId: string; toolName: string; args: unknown }
export interface ToolExecutionEndEvent { toolCallId: string; toolName: string; isError: boolean; result?: unknown }

export interface TurnEndEvent { turnIndex?: number }

interface ExtensionEvents {
  turn_end: TurnEndEvent;
  tool_execution_start: ToolExecutionStartEvent;
  tool_execution_end: ToolExecutionEndEvent;
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  context: ContextEvent;
  session_start: unknown;
  session_shutdown: unknown;
}

/**
 * Structurally compatible with Pi's `ToolDefinition`. Same-name registration
 * overrides a built-in tool, and omitted renderers inherit the built-in one.
 */
export interface WelderToolDefinition {
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
  renderCall?: (args: any, theme: any, context: any) => unknown;
  renderResult?: (result: any, options: any, theme: any, context: any) => unknown;
}

export interface ExtensionHost extends CommandRegistrar {
  registerTool(tool: WelderToolDefinition): void;
  on<EventName extends keyof ExtensionEvents>(
    event: EventName,
    handler: (event: ExtensionEvents[EventName], context: WelderContext) => Promise<unknown>,
  ): void;
}
