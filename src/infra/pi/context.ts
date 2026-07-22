import * as path from "node:path";
import type { WelderContext } from "./contracts.ts";

export const logDir = (ctx: Partial<Pick<WelderContext, "cwd">>) => path.join(ctx.cwd ?? process.cwd(), ".pi", "welder-log");

export const sessionId = (ctx: Pick<WelderContext, "sessionManager">): string => ctx.sessionManager?.getSessionId?.() ?? "unknown";

export const modelMeta = (ctx: Pick<WelderContext, "model">) => ({
  provider: ctx.model?.provider ?? "unknown",
  model: ctx.model?.id ?? "unknown",
});
