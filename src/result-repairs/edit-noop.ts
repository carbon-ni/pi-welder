import { resolve } from "node:path";

import { nodeFileSystem, type FileSystem } from "../infra/filesystem.ts";
import type { ToolResultShape } from "./types.ts";

const MAX_FILE_BYTES = 200_000;

interface EditInput {
  oldText: string;
  newText: string;
}

export interface EditNoopResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    editNoop: {
      path: string;
      verified: true;
    };
  };
  isError: false;
}

/** Convert a verified single no-op edit failure into successful desired state. */
export async function recoverEditNoop(
  event: ToolResultShape,
  cwd: string,
  fileSystem: FileSystem = nodeFileSystem,
): Promise<EditNoopResult | undefined> {
  if (event.toolName !== "edit" || !event.isError) return undefined;
  if (!isIdenticalReplacementError(extractText(event.content))) return undefined;

  const target = event.input?.path;
  const edit = singleEdit(event.input?.edits);
  if (typeof target !== "string" || !edit || edit.oldText.length === 0) return undefined;
  if (edit.oldText !== edit.newText) return undefined;

  const current = await fileSystem.readFile(resolve(cwd, target)).catch(() => undefined);
  if (current === undefined || Buffer.byteLength(current, "utf8") > MAX_FILE_BYTES) return undefined;
  if (!current.includes(edit.oldText)) return undefined;

  return {
    content: [{ type: "text", text: `No change required: ${target} already matches current content.` }],
    details: { editNoop: { path: target, verified: true } },
    isError: false,
  };
}

function singleEdit(value: unknown): EditInput | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const edit = value[0];
  if (!edit || typeof edit !== "object") return undefined;
  const candidate = edit as Partial<EditInput>;
  if (typeof candidate.oldText !== "string" || typeof candidate.newText !== "string") return undefined;
  return { oldText: candidate.oldText, newText: candidate.newText };
}

function isIdenticalReplacementError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return lower.includes("no changes made") && lower.includes("replacement produced identical content");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => item && typeof item === "object" && "text" in item
      ? (item as { text?: unknown }).text
      : "")
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}
