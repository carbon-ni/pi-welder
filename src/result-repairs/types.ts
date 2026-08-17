import type { Repair } from "../repairs/index.ts";
import type { DirectoryReadResult } from "./directory-read.ts";
import type { EditNoopResult } from "./edit-noop.ts";
import type { MissingReadContextResult } from "./missing-read-context.ts";
import type { ReadOffsetContextResult } from "./read-offset-context.ts";

export interface ToolResultShape {
  toolName: string;
  input?: Record<string, unknown>;
  isError?: boolean;
  content?: unknown;
}

export type ResultRepairPatch = DirectoryReadResult | EditNoopResult | MissingReadContextResult | ReadOffsetContextResult;

export interface ResultRepair {
  patch: ResultRepairPatch;
  repairs: Repair[];
}

export interface ResultRepairRule {
  name: string;
  repair(event: ToolResultShape, cwd: string): Promise<ResultRepair | undefined>;
}
