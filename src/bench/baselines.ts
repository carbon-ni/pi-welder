/**
 * Benchmark baselines and candidate gates (contract v2 §8, §4).
 *
 * B0 = no message. B1 = shipped repair-warning hint text plus factual
 * result-repair enrichment. Generic recovery phrasing is structurally
 * rejected by `validateCandidateMessage` — it can never be scored.
 */

import { repairActionHint } from "../repair-warnings.ts";

export interface CandidateEpisode {
  kind: "repair-warning" | "result-repair";
  repairs: string[];
}

export interface BenchCandidate {
  id: string;
  message(episode: CandidateEpisode): string | null;
}

export const NO_MESSAGE: BenchCandidate = {
  id: "B0-no-message",
  message: () => null,
};

/** Factual summaries of the four shipped result-repair patches. */
const RESULT_REPAIR_FACTS: ReadonlyMap<string, string> = new Map([
  ["directory-read", "directory-read: the path was a directory, so the result was replaced by a listing of its entries"],
  ["read-offset-context", "read-offset-context: the requested offset was past EOF, so the result returned the file tail with a corrected offset"],
  ["missing-read-context", "missing-read-context: the path was not found, so the result included the nearest existing directory listing for context"],
  ["edit-noop", "edit-noop: oldText equaled newText, so the verified no-op edit was converted into a success"],
]);

export const SHIPPED: BenchCandidate = {
  id: "B1-shipped",
  message(episode) {
    if (episode.kind === "repair-warning") {
      const lines = episode.repairs.map((action) => {
        const hint = repairActionHint(action);
        return `- ${action}: ${hint ?? "avoid repeating this repair"}`;
      });
      return `pi-welder repair hints: recent tool calls were repaired. To avoid these repairs next time:\n${lines.join("\n")}`;
    }
    const facts = episode.repairs
      .map((action) => RESULT_REPAIR_FACTS.get(action))
      .filter((fact): fact is string => fact !== undefined);
    if (facts.length === 0) return null;
    return `pi-welder applied deterministic result repairs:\n${facts.map((fact) => `- ${fact}`).join("\n")}`;
  },
};

const GENERIC_PATTERNS: readonly RegExp[] = [
  /let'?s (try|fix|check|retry|adjust)/i,
  /we apologize/i,
  /sorry for/i,
  /please (try|retry|check|fix) again/i,
];

export const MAX_MESSAGE_LENGTH = 480;

/** Returns a violation reason, or null when the message is eligible. */
export function validateCandidateMessage(episode: CandidateEpisode, message: string | null): string | null {
  if (message === null) return null;
  if (message.length > MAX_MESSAGE_LENGTH) return "too-long";
  for (const pattern of GENERIC_PATTERNS) {
    if (pattern.test(message)) return "generic-recovery";
  }
  if (!episode.repairs.some((action) => message.includes(action))) return "missing-action-reference";
  return null;
}
