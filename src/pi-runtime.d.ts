/**
 * Runtime type declarations for the pi extension host.
 *
 * The real types ship inside the pi runtime (`@earendil-works/pi-coding-agent`)
 * and are not installed via npm in this repo. These minimal declarations let
 * the extension typecheck standalone; the runtime binds the real values.
 */
declare module "@earendil-works/pi-coding-agent" {
  export interface ToolCallEvent {
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
  }

  export interface ExtensionContext {
    hasUI: boolean;
    cwd: string;
    model?: { provider?: string; id?: string };
    sessionManager?: { getSessionId?: () => string };
    ui: {
      notify(message: string, kind?: "info" | "warn" | "error"): void;
      setStatus(key: string, value: string | undefined): void;
    };
  }

  export interface ExtensionAPI {
    on(
      event: "tool_call" | "tool_result" | "session_start" | "session_shutdown",
      handler: (event: any, ctx: ExtensionContext) => Promise<unknown>,
    ): void;
    registerCommand(
      name: string,
      def: {
        description: string;
        handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
      },
    ): void;
  }
}
