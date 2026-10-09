import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { Candidate, Project } from "../../shared/types";
import { WORKTREES_SUFFIX } from "../git/worktrees";
import { projectId } from "./ids";
import { detectStack } from "./stacks";

const SPEC_CANDIDATES = [
  path.join(".devcontainer", "devcontainer.json"),
  ".devcontainer.json",
];
const SKIP_DIRS = new Set(["node_modules"]);

export const findDevcontainerSpec = async (
  dir: string
): Promise<string | undefined> => {
  for (const rel of SPEC_CANDIDATES) {
    const candidate = path.join(dir, rel);
    try {
      const result = await fs.stat(candidate);
      if (result.isFile()) {
        return candidate;
      }
    } catch {
      // not present or unreadable
    }
  }
  return undefined;
};

const isGitRepo = async (dir: string): Promise<boolean> => {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
};

/**
 * Visits folders under each root up to `maxDepth`, skipping dotfolders, node_modules and
 * worktree folders. `claim` returns true when it has taken a folder, so the walk doesn't go
 * inside it.
 */
const walk = async (
  roots: string[],
  maxDepth: number,
  onWarn: (msg: string) => void,
  claim: (dir: string, root: string) => Promise<boolean>
): Promise<void> => {
  const visit = async (
    dir: string,
    root: string,
    depth: number
  ): Promise<void> => {
    if (await claim(dir, root)) {
      return;
    }
    if (depth >= maxDepth) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (depth === 0) {
        onWarn(
          `opendevhub: cannot read root ${dir}: ${(error as Error).message}`
        );
      }
      return;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        SKIP_DIRS.has(entry.name)
      ) {
        continue;
      }
      // Worktrees opendevhub keeps next to a project carry its devcontainer.json too; they aren't projects.
      if (entry.name.endsWith(WORKTREES_SUFFIX)) {
        continue;
      }
      await visit(path.join(dir, entry.name), root, depth + 1);
    }
  };
  for (const root of roots) {
    const resolved = path.resolve(root);
    await visit(resolved, resolved, 0);
  }
};

export const scanRoots = async (
  roots: string[],
  maxDepth = 2,
  onWarn: (msg: string) => void = (m) => console.warn(m)
): Promise<Project[]> => {
  const found = new Map<string, Project>();
  await walk(roots, maxDepth, onWarn, async (dir) => {
    if (found.has(dir)) {
      return true;
    }
    const spec = await findDevcontainerSpec(dir);
    if (!spec) {
      return false;
    }
    found.set(dir, {
      devcontainerPath: spec,
      id: projectId(dir),
      name: path.basename(dir),
      path: dir,
    });
    return true;
  });
  return [...found.values()].toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  );
};

/** Git repos under the roots that have no devcontainer: what Add project offers. */
export const scanCandidates = async (
  roots: string[],
  maxDepth = 2,
  onWarn: (msg: string) => void = (m) => console.warn(m)
): Promise<Candidate[]> => {
  const found = new Map<string, Candidate>();
  const projects = new Set<string>();
  await walk(roots, maxDepth, onWarn, async (dir, root) => {
    if (found.has(dir) || projects.has(dir)) {
      return true;
    }
    if (await findDevcontainerSpec(dir)) {
      projects.add(dir);
      return true;
    }
    if (!(await isGitRepo(dir))) {
      return false;
    }
    found.set(dir, {
      name: path.basename(dir),
      path: dir,
      root,
      stack: await detectStack(dir),
    });
    return true;
  });
  return [...found.values()].toSorted(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  );
};
