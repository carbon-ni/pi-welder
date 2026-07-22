import path from "node:path";

import { nodeFileSystem, type FileSystem } from "../infra/filesystem.ts";
import { resolveReadPath } from "./directory-read.ts";
import type { ToolResultShape } from "./types.ts";

const MAX_DEPTH = 2;
const MAX_ENTRIES = 80;
const MAX_ERROR_BYTES = 1_000;
const MAX_CONTEXT_BYTES = 5_000;

export interface MissingReadContextResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    missingReadContext: {
      requestedPath: string;
      treeRoot: string;
      entries: number;
      truncated: boolean;
    };
  };
  isError: true;
}

interface TreeState {
  entries: number;
  truncated: boolean;
  lines: string[];
}

export async function appendMissingReadContext(
  event: ToolResultShape,
  cwd: string,
  fileSystem: FileSystem = nodeFileSystem,
): Promise<MissingReadContextResult | undefined> {
  if (event.toolName !== "read" || !event.isError) return undefined;

  const requestedPath = event.input?.path;
  const errorText = extractText(event.content);
  if (typeof requestedPath !== "string" || !isMissingPathError(errorText)) return undefined;

  const resolvedPath = resolveReadPath(requestedPath, cwd);
  if (await pathExists(resolvedPath, fileSystem)) return undefined;

  const treeRoot = await nearestExistingDirectory(path.dirname(resolvedPath), fileSystem);
  if (!treeRoot) return undefined;

  const tree = await renderTree(treeRoot, fileSystem);
  if (!tree) return undefined;

  const context = [
    truncateUtf8(errorText, MAX_ERROR_BYTES),
    "",
    `Requested path: ${requestedPath}`,
    `Tree from: ${treeRoot}`,
    ".",
    ...tree.lines,
    ...(tree.truncated ? ["… tree truncated"] : []),
  ].join("\n");

  return {
    content: [{ type: "text", text: truncateUtf8(context, MAX_CONTEXT_BYTES) }],
    details: {
      missingReadContext: {
        requestedPath,
        treeRoot,
        entries: tree.entries,
        truncated: tree.truncated || Buffer.byteLength(context, "utf8") > MAX_CONTEXT_BYTES,
      },
    },
    isError: true,
  };
}

async function nearestExistingDirectory(candidate: string, fileSystem: FileSystem): Promise<string | undefined> {
  let current = candidate;

  while (true) {
    try {
      if ((await fileSystem.stat(current)).isDirectory()) return current;
    } catch {
      // Continue toward the nearest existing ancestor.
    }

    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function renderTree(root: string, fileSystem: FileSystem): Promise<TreeState | undefined> {
  const state: TreeState = { entries: 0, truncated: false, lines: [] };
  const readable = await appendDirectory(root, "", 1, state, fileSystem);
  return readable ? state : undefined;
}

async function appendDirectory(
  directory: string,
  prefix: string,
  depth: number,
  state: TreeState,
  fileSystem: FileSystem,
): Promise<boolean> {
  let entries;
  try {
    entries = await fileSystem.readdir(directory);
  } catch {
    return false;
  }

  const sortedEntries = entries.sort((a, b) => a.name.localeCompare(b.name));
  for (let index = 0; index < sortedEntries.length; index++) {
    if (state.entries >= MAX_ENTRIES) {
      state.truncated = true;
      break;
    }

    const entry = sortedEntries[index]!;
    const isLast = index === sortedEntries.length - 1;
    const isDirectory = entry.isDirectory();
    state.lines.push(`${prefix}${isLast ? "└──" : "├──"} ${entry.name}${isDirectory ? "/" : ""}`);
    state.entries++;

    if (!isDirectory) continue;
    if (depth >= MAX_DEPTH) {
      state.truncated = true;
      continue;
    }

    const childPrefix = `${prefix}${isLast ? "    " : "│   "}`;
    await appendDirectory(path.join(directory, entry.name), childPrefix, depth + 1, state, fileSystem);
  }

  return true;
}

async function pathExists(target: string, fileSystem: FileSystem): Promise<boolean> {
  try {
    await fileSystem.stat(target);
    return true;
  } catch {
    return false;
  }
}

function isMissingPathError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return lower.includes("enoent") || lower.includes("no such file");
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object" || !("text" in item)) return "";
      const text = (item as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, Math.max(0, maxBytes - 3)).toString("utf8").replace(/\uFFFD$/, "") + "…";
}
