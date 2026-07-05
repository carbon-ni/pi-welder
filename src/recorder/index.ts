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
export { appendEvent, loadAllEvents, listSessionLogs, pruneOldSessions, readEvents, sessionLogPath, writeFailureReport, FAILURE_REPORT_FILENAME } from "./log.ts";
export { createStats, recordRepairs, recordToolFailure, statsSummary } from "./stats.ts";
export type { Stats } from "./stats.ts";
export { aggregateFailures } from "./aggregate.ts";
export type { FailureCluster, FailureSample, AggregateOptions, FailureEvent } from "./aggregate.ts";
export { formatFailureReport } from "./report.ts";
export {
  extractPiFailures,
  loadPiSessionEvents,
  readPiSessionFile,
} from "./pi-session-source.ts";
export type { Repair } from "../repairs/index.ts";
