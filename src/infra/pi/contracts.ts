export interface WelderUi {
  notify(message: string, kind?: "info" | "warn" | "error"): void;
  setStatus(key: string, value: string | undefined): void;
}

export interface WelderContext {
  hasUI: boolean;
  cwd: string;
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

interface ExtensionEvents {
  tool_call: ToolCallEvent;
  tool_result: ToolResultEvent;
  context: ContextEvent;
  session_start: unknown;
  session_shutdown: unknown;
}

export interface ExtensionHost extends CommandRegistrar {
  on<EventName extends keyof ExtensionEvents>(
    event: EventName,
    handler: (event: ExtensionEvents[EventName], context: WelderContext) => Promise<unknown>,
  ): void;
}
