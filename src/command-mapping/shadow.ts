/**
 * TASK-0035 — runtime shadow observer. Measurement only.
 *
 * The observer runs after the exact router refused a shape. It enumerates
 * command-mapping hypotheses, derives closed features locally, and — when the
 * shadow client is enabled — submits one privacy-safe request. It never mutates
 * arguments, never executes a command, and never records raw values.
 */

import { enumerateCommandMapping, mappingOptions, type MappingEnumeration } from "./candidates.ts";
import { buildMappingRequest, parseMappingResponse, type MappingPriorSignals, type MappingResponse } from "./evaluation.ts";

export interface MappingShadowEvidence {
  caseId: string;
  sourceTool: string;
  candidateCount: number;
  /** Ordinal chosen by the model, or undefined when it abstained. */
  selectedOrdinal?: number;
  confidence?: number;
  status: "abstained" | "selected" | "unavailable" | "malformed";
}

/** Minimal client contract; the TypeSafe client's second (signal) parameter is optional here. */
export interface MappingShadowClient {
  choose(request: never, signal?: unknown): Promise<unknown>;
}

export interface MappingShadow {
  observe(input: { toolCallId: string; toolName: string; args: unknown; prior?: MappingPriorSignals }): MappingEnumeration;
  drain(): Promise<void>;
  pending: number;
}

export function createMappingShadow(options: {
  client: MappingShadowClient;
  isEnabled: () => boolean;
  onEvidence?: (evidence: MappingShadowEvidence) => void;
}): MappingShadow {
  let pending = 0;
  const inFlight: Promise<void>[] = [];

  return {
    observe({ toolCallId, toolName, args, prior }) {
      const enumeration = enumerateCommandMapping(toolName, args);
      if (!options.isEnabled()) return enumeration;
      if (enumeration.status !== "candidates") return enumeration;

      const request = buildMappingRequest(toolName, enumeration.candidates, { canonicalTimeout: enumeration.canonicalTimeout, ...(prior === undefined ? {} : { prior }) });
      const optionList = mappingOptions(enumeration.candidates.length);
      const caseId = `${toolName}:${toolCallId}`;
      const candidateCount = enumeration.candidates.length;
      pending++;
      const task = options.client
        .choose(request as never)
        .then((raw) => {
          const parsed = typeof raw === "string" ? parseMappingResponse(raw, optionList) : parseMappingResponse(JSON.stringify(raw), optionList);
          if (parsed === undefined) {
            options.onEvidence?.({ caseId, sourceTool: toolName, candidateCount, status: "malformed" });
            return;
          }
          const confidence = parsed.confidence === undefined ? {} : { confidence: parsed.confidence };
          if (parsed.choice === "none") {
            options.onEvidence?.({ caseId, sourceTool: toolName, candidateCount, status: "abstained", ...confidence });
            return;
          }
          options.onEvidence?.({
            caseId,
            sourceTool: toolName,
            candidateCount,
            status: "selected",
            selectedOrdinal: Number(parsed.choice.slice("candidate-".length)),
            ...confidence,
          });
        })
        .catch(() => {
          options.onEvidence?.({ caseId, sourceTool: toolName, candidateCount, status: "unavailable" });
        })
        .finally(() => {
          pending--;
        });
      inFlight.push(task);
      return enumeration;
    },
    async drain() {
      await Promise.allSettled(inFlight);
      inFlight.length = 0;
    },
    get pending() {
      return pending;
    },
  };
}
