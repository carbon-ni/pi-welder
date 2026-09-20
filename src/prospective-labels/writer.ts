/**
 * TASK-0037 — bounded, privacy-safe JSONL writer for prospective labels.
 *
 * Writes only pre-rendered, privacy-safe lines (keys, roles, ordinals,
 * counters). It never receives raw arguments or result text, and failures are
 * swallowed by the caller so logging can never break the tool flow.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const LABEL_LINE_MAX_BYTES = 2_000;

export async function appendLine(
  dir: string,
  file: string,
  line: string,
  options: { mkdirImpl?: typeof mkdir; appendImpl?: typeof appendFile } = {},
): Promise<void> {
  if (Buffer.byteLength(line, "utf8") > LABEL_LINE_MAX_BYTES) return;
  if (line.includes("\n")) return;
  const makeDir = options.mkdirImpl ?? mkdir;
  const append = options.appendImpl ?? appendFile;
  await makeDir(dir, { recursive: true });
  await append(join(dir, file), `${line}\n`);
}
