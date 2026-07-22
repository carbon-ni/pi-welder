import { homedir } from "node:os";
import path from "node:path";
import { nodeFileSystem, type FileSystem } from "../infra/filesystem.ts";

const MAX_ENTRIES = 200;

export interface DirectoryReadResult {
  content: Array<{ type: "text"; text: string }>;
  details: { path: string; entries: number; truncated: boolean };
  isError: false;
}

export function resolveReadPath(inputPath: string, cwd: string): string {
  if (inputPath === "~") return homedir();
  if (inputPath.startsWith("~/")) return path.join(homedir(), inputPath.slice(2));
  return path.resolve(cwd, inputPath);
}

export async function listDirectoryForRead(
  inputPath: string,
  cwd: string,
  fileSystem: FileSystem = nodeFileSystem,
): Promise<DirectoryReadResult | undefined> {
  const resolvedPath = resolveReadPath(inputPath, cwd);

  try {
    const info = await fileSystem.stat(resolvedPath);
    if (!info.isDirectory()) return undefined;

    const allEntries = await fileSystem.readdir(resolvedPath);
    const entries = allEntries
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_ENTRIES)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
    const truncated = allEntries.length > MAX_ENTRIES;
    const suffix = truncated ? `\n… ${allEntries.length - MAX_ENTRIES} more entries` : "";

    return {
      content: [{ type: "text", text: `Directory: ${resolvedPath}\n\n${entries.join("\n")}${suffix}` }],
      details: { path: resolvedPath, entries: allEntries.length, truncated },
      isError: false,
    };
  } catch {
    return undefined;
  }
}
