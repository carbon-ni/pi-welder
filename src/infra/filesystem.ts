import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";

export interface FileInfo {
  isDirectory(): boolean;
}

export interface DirectoryEntry extends FileInfo {
  name: string;
}

export interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  stat(path: string): Promise<FileInfo>;
  readdir(path: string): Promise<DirectoryEntry[]>;
  /** Used by source shadowing for symlink-safe path containment; absent = fail closed. */
  realpath?(path: string): Promise<string>;
}

export const nodeFileSystem: FileSystem = {
  readFile: (path) => readFile(path, "utf8"),
  writeFile: (path, content) => writeFile(path, content, "utf8"),
  stat,
  readdir: (path) => readdir(path, { withFileTypes: true }),
  realpath: (path) => realpath(path),
};
