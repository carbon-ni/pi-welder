/**
 * TASK-0033 — closed tool contracts for wrong-tool routing.
 *
 * Every contract derives its key set and value types from the verified local
 * runtime schema (`src/schemas.ts`); this module adds only the required/
 * optional split and the capability class. A test asserts that the registry
 * stays consistent with the runtime schema, so the routing view cannot drift
 * from the tool contracts the project actually ships.
 */

import { TOOL_SCHEMAS, type ToolSchema } from "../schemas.ts";

export type ValueType = "string" | "number" | "boolean" | "array" | "object";

export type Capability = "read-only" | "filesystem-mutation" | "process-execution" | "external-side-effect";

/** Ordered by side-effect strength; a higher rank is a capability escalation. */
export const CAPABILITY_ORDER: readonly Capability[] = ["read-only", "filesystem-mutation", "process-execution", "external-side-effect"];

export interface ToolContract {
  tool: string;
  required: readonly string[];
  optional: readonly string[];
  types: Readonly<Record<string, ValueType>>;
  capability: Capability;
}

/**
 * Required keys come from the shipped tool definitions. Optional keys are the
 * remaining keys of the runtime schema. No other field is invented here.
 */
const CONTRACT_SPECS: readonly { tool: string; required: readonly string[]; capability: Capability }[] = [
  { tool: "read", required: ["path"], capability: "read-only" },
  { tool: "write", required: ["path", "content"], capability: "filesystem-mutation" },
  { tool: "edit", required: ["path", "edits"], capability: "filesystem-mutation" },
  { tool: "bash", required: ["command"], capability: "process-execution" },
];

function contractFrom(spec: { tool: string; required: readonly string[]; capability: Capability }, schema: ToolSchema): ToolContract {
  const keys = Object.keys(schema);
  const types: Record<string, ValueType> = {};
  for (const key of keys) types[key] = schema[key]!.type;
  return {
    tool: spec.tool,
    required: [...spec.required],
    optional: keys.filter((key) => !spec.required.includes(key)),
    types,
    capability: spec.capability,
  };
}

export const TOOL_CONTRACTS: ReadonlyMap<string, ToolContract> = new Map(
  CONTRACT_SPECS.flatMap((spec) => {
    const schema = TOOL_SCHEMAS.get(spec.tool);
    return schema === undefined ? [] : [[spec.tool, contractFrom(spec, schema)] as const];
  }),
);

/** Capability for a source tool that has no routing schema (never a candidate). */
const SOURCE_CAPABILITIES: Readonly<Record<string, Capability>> = {
  read: "read-only",
  write: "filesystem-mutation",
  edit: "filesystem-mutation",
  bash: "process-execution",
  send_to_session: "external-side-effect",
  send_member_request: "external-side-effect",
  send_follow_up: "external-side-effect",
};

export function contractFor(tool: string | undefined): ToolContract | undefined {
  return tool === undefined ? undefined : TOOL_CONTRACTS.get(tool);
}

export function capabilityOf(tool: string | undefined): Capability | undefined {
  return tool === undefined ? undefined : SOURCE_CAPABILITIES[tool] ?? TOOL_CONTRACTS.get(tool)?.capability;
}

export function capabilityRank(capability: Capability): number {
  return CAPABILITY_ORDER.indexOf(capability);
}

/** True when routing to the target would grant a stronger side effect. */
export function isCapabilityEscalation(source: string | undefined, target: Capability): boolean {
  const sourceCapability = capabilityOf(source);
  if (sourceCapability === undefined) return true; // unknown source: never assume equal-or-lower
  return capabilityRank(target) > capabilityRank(sourceCapability);
}

/** Routing is only ever considered for equal-or-lower capability. */
export function isRoutingAllowed(source: string | undefined, target: Capability): boolean {
  return !isCapabilityEscalation(source, target);
}

/** Guards the registry against drift from the shipped runtime schema. */
export function registryConsistentWithRuntime(): boolean {
  for (const [tool, contract] of TOOL_CONTRACTS.entries()) {
    const schema = TOOL_SCHEMAS.get(tool);
    if (schema === undefined) return false;
    const keys = Object.keys(schema).sort();
    const contractKeys = [...contract.required, ...contract.optional].sort();
    if (keys.length !== contractKeys.length || keys.some((key, index) => key !== contractKeys[index])) return false;
    if (keys.some((key) => contract.types[key] !== schema[key]!.type)) return false;
  }
  return TOOL_CONTRACTS.size === CONTRACT_SPECS.length;
}
