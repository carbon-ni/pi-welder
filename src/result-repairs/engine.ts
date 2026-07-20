import { listDirectoryForRead } from "./directory-read.ts";
import { appendMissingReadContext } from "./missing-read-context.ts";
import type { ResultRepair, ResultRepairRule, ToolResultShape } from "./types.ts";

const directoryReadRule: ResultRepairRule = {
  name: "directory-read",
  async repair(event, cwd) {
    if (event.toolName !== "read" || !event.isError) return undefined;
    const inputPath = event.input?.path;
    if (typeof inputPath !== "string") return undefined;
    const patch = await listDirectoryForRead(inputPath, cwd);
    if (!patch) return undefined;
    return { patch, repairs: [{ field: "path", action: "directory-read" }] };
  },
};

const missingReadContextRule: ResultRepairRule = {
  name: "missing-read-context",
  async repair(event, cwd) {
    const patch = await appendMissingReadContext(event, cwd);
    if (!patch) return undefined;
    return { patch, repairs: [{ field: "path", action: "missing-read-context" }] };
  },
};

export const resultRepairRules: readonly ResultRepairRule[] = Object.freeze([
  directoryReadRule,
  missingReadContextRule,
]);

export async function repairToolResult(
  event: ToolResultShape,
  cwd: string,
  rules: readonly ResultRepairRule[] = resultRepairRules,
): Promise<ResultRepair | undefined> {
  for (const rule of rules) {
    const repaired = await rule.repair(event, cwd);
    if (repaired) return repaired;
  }
  return undefined;
}
