/**
 * Mine pi-welder failures from the project root.
 * Usage: node --experimental-strip-types run-mine.ts [pi|welder|all]
 *
 * Imports from the public recorder facade so internal module paths can move.
 */
import * as path from "node:path";
import {
  loadAllEvents,
  loadPiSessionEvents,
  writeFailureReport,
} from "../../../../src/recorder/index.ts";
import {
  loadMineEvents,
  mineFailures,
  mineSummary,
  PI_SESSIONS_DIR,
} from "../../../../src/commands.ts";

const source = (process.argv[2] ?? "all") as "pi" | "welder" | "all";
const dir = path.join(process.cwd(), ".pi", "welder-log");

const events = await loadMineEvents(source, {
  welderLogDir: dir,
  piSessionsDir: PI_SESSIONS_DIR,
  loadWelder: loadAllEvents,
  loadPi: loadPiSessionEvents,
});

const result = await mineFailures(events, dir, writeFailureReport, source);
console.log(mineSummary(result));
