import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Project } from "../shared/types";
import { projectId } from "./ids";
import { WORKTREES_SUFFIX } from "./worktrees";

const SPEC_CANDIDATES = [path.join(".devcontainer", "devcontainer.json"), ".devcontainer.json"];
const SKIP_DIRS = new Set(["node_modules"]);

export async function findDevcontainerSpec(dir: string): Promise<string | undefined> {
  for (const rel of SPEC_CANDIDATES) {
    const candidate = path.join(dir, rel);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // not present or unreadable
    }
  }
  return undefined;
}

export async function scanRoots(
  roots: string[],
  maxDepth = 2,
  onWarn: (msg: string) => void = (m) => console.warn(m),
): Promise<Project[]> {
  const found = new Map<string, Project>();

  async function visit(dir: string, depth: number): Promise<void> {
    if (found.has(dir)) return;
    const spec = await findDevcontainerSpec(dir);
    if (spec) {
      found.set(dir, { id: projectId(dir), name: path.basename(dir), path: dir, devcontainerPath: spec });
      return;
    }
    if (depth >= maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) onWarn(`opendevhub: cannot read root ${dir}: ${(err as Error).message}`);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      // Worktrees opendevhub keeps next to a project carry its devcontainer.json too; they aren't projects.
      if (entry.name.endsWith(WORKTREES_SUFFIX)) continue;
      await visit(path.join(dir, entry.name), depth + 1);
    }
  }

  for (const root of roots) await visit(path.resolve(root), 0);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}
