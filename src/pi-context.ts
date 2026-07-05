import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const logDir = (ctx: ExtensionContext) => path.join(ctx.cwd ?? process.cwd(), ".pi", "welder-log");

export const sessionId = (ctx: ExtensionContext): string => ctx.sessionManager?.getSessionId?.() ?? "unknown";

export const modelMeta = (ctx: ExtensionContext) => ({
  provider: ctx.model?.provider ?? "unknown",
  model: ctx.model?.id ?? "unknown",
});
