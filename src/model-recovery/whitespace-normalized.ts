/**
 * Whitespace-normalized matching: locate a target in content ignoring all
 * whitespace differences. Used to recover oldText values that drifted from
 * the file only in spacing/indentation.
 *
 * Guard: compact targets shorter than 8 chars are too ambiguous to trust.
 */
export function whitespaceNormalizedOffsets(content: string, target: string): Array<{ start: number; end: number }> {
  const compactTarget = target.replace(/\s+/g, "");
  if (compactTarget.length < 8) return [];

  let compactCurrent = "";
  const sourceOffsets: number[] = [];
  for (let index = 0; index < content.length; index++) {
    if (/\s/.test(content[index]!)) continue;
    compactCurrent += content[index];
    sourceOffsets.push(index);
  }

  const offsets: number[] = [];
  for (let from = 0; (from = compactCurrent.indexOf(compactTarget, from)) !== -1; from += compactTarget.length) {
    offsets.push(from);
  }
  return offsets.map((offset) => ({
    start: sourceOffsets[offset]!,
    end: (sourceOffsets[offset + compactTarget.length - 1] ?? sourceOffsets[offset]!) + 1,
  }));
}
