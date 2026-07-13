import type { Repair } from "../repairs/index.ts";
import type { DirectoryReadResult } from "./directory-read.ts";

export interface ToolResultShape {
  toolName: string;
  input?: Record<string, unknown>;
  isError?: boolean;
}

export interface ResultRepair {
  patch: DirectoryReadResult;
  repairs: Repair[];
}

export interface ResultRepairRule {
  name: string;
  repair(event: ToolResultShape, cwd: string): Promise<ResultRepair | undefined>;
}
