export type RepairAction =
  | "strip-null"
  | "strip-null-like"
  | "clean-path"
  | "parse-json"
  | "wrap-array"
  | "wrap-object-array"
  | "split-string"
  | "coerce-boolean"
  | "coerce-number"
  | "strip-extra-props"
  | "rename-aliased-field"
  | "relational-default"
  | "nest-edit-fields"
  | "directory-read";

export interface Repair {
  field: string;
  action: RepairAction;
}

export interface RepairValidation {
  checked: boolean;
  passed: boolean;
  rejected: boolean;
}

export interface RepairResult {
  result: Record<string, unknown>;
  repairs: Repair[];
  validation?: RepairValidation;
}

export interface RepairContext {
  key: string;
  fieldPath: string;
  parsedFromString: boolean;
  toolName?: string;
}

export interface RuleResult {
  value: unknown;
  repairs: Repair[];
  parsedFromString?: boolean;
}

export interface RepairOptions {
  toolName?: string;
  rules?: readonly RepairRule[];
  extraRules?: readonly RepairRule[];
  objectRules?: readonly ObjectRepairRule[];
  extraObjectRules?: readonly ObjectRepairRule[];
}

export interface ResolvedRepairOptions {
  toolName?: string;
  rules: readonly RepairRule[];
  objectRules: readonly ObjectRepairRule[];
}

export interface RepairRule {
  /** Stable registry name; array-shape may emit split/wrap repair actions. */
  action: RepairAction | "array-shape";
  repair(value: unknown, ctx: RepairContext): RuleResult;
}

export interface ObjectRuleResult {
  result: Record<string, unknown>;
  repairs: Repair[];
}

export interface ObjectRepairContext {
  parentPath: string;
  toolName?: string;
}

export interface ObjectRepairRule {
  action: RepairAction;
  repair(input: Record<string, unknown>, ctx: ObjectRepairContext): ObjectRuleResult;
}
