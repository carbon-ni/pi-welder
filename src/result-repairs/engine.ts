import { listDirectoryForRead } from "./directory-read.ts";
import { recoverEditNoop } from "./edit-noop.ts";
import { appendMissingReadContext } from "./missing-read-context.ts";
import { recoverReadOffsetContext } from "./read-offset-context.ts";
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

const readOffsetContextRule: ResultRepairRule = {
  name: "read-offset-context",
  async repair(event, cwd) {
    const patch = await recoverReadOffsetContext(event, cwd);
    if (!patch) return undefined;
    return { patch, repairs: [{ field: "offset", action: "read-offset-context" }] };
  },
};

const editNoopRule: ResultRepairRule = {
  name: "edit-noop",
  async repair(event, cwd) {
    const patch = await recoverEditNoop(event, cwd);
    if (!patch) return undefined;
    return { patch, repairs: [{ field: "edits[0]", action: "edit-noop" }] };
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
  readOffsetContextRule,
  editNoopRule,
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
