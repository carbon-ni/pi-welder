/**
 * Observability — in-memory stats + append-only JSONL event log.
 *
 * Stats are pure counters (no I/O). The log is one JSON object per line at
 * `.pi/welder-log/<sessionId>.jsonl`, pruneable to a bounded retention.
 * Schema is intentionally lean: enough to answer "what does this model get
 * wrong?" without burdening disk or the LLM context.
 */

export { buildEvent, buildToolResultEvent } from "./events.ts";
export type { WelderEvent } from "./events.ts";
export { appendEvent, pruneOldSessions, readEvents, sessionLogPath } from "./log.ts";
export { createStats, recordRepairs, recordToolFailure, statsSummary } from "./stats.ts";
export type { Stats } from "./stats.ts";
export type { Repair } from "../repairs/index.ts";
