import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const EXEC_BITS = 0o111;

/**
 * node-pty 1.1.0 ships `prebuilds/<platform>-<arch>/spawn-helper` without its execute bit and nothing in its
 * install scripts sets it, so every pty spawn on macOS fails with `posix_spawnp failed`. That covers our
 * terminals and, because package-manager shims put our node_modules on NODE_PATH, the devcontainer CLI too: it
 * loads node-pty from NODE_PATH first. Restores the bit in place; best effort, since a read-only install can't be
 * fixed from here.
 */
export const ensureSpawnHelperExecutable = (
  root: string | undefined = resolvePtyRoot(),
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string[] => {
  if (platform === "win32" || !root) {
    return [];
  }
  const fixed: string[] = [];
  for (const dir of [
    "build/Release",
    "build/Debug",
    `prebuilds/${platform}-${arch}`,
  ]) {
    const helper = path.join(root, dir, "spawn-helper");
    try {
      const { mode } = fs.statSync(helper);
      if ((mode & EXEC_BITS) !== EXEC_BITS) {
        fs.chmodSync(helper, mode | EXEC_BITS);
        fixed.push(helper);
      }
    } catch {
      /* Missing, or not ours to change. */
    }
  }
  return fixed;
};

const resolvePtyRoot = (): string | undefined => {
  try {
    return path.dirname(
      createRequire(import.meta.url).resolve("node-pty/package.json")
    );
  } catch {
    return undefined;
  }
};
