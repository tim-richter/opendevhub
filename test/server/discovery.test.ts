import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanRoots } from "../../src/server/discovery";

let root: string;
function mk(rel: string, file?: string) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (file) fs.writeFileSync(path.join(dir, file), "{}");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "odh-scan-"));
});
afterEach(() => {
  fs.chmodSync(root, 0o755);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("scanRoots", () => {
  it("finds projects at depth 1 and 2 with either spec location", async () => {
    mk("a/.devcontainer", "devcontainer.json");
    mk("org/b", ".devcontainer.json");
    const found = await scanRoots([root]);
    expect(found.map((p) => p.name)).toEqual(["a", "b"]);
    expect(found[0].devcontainerPath).toBe(path.join(root, "a/.devcontainer/devcontainer.json"));
    expect(found[1].path).toBe(path.join(root, "org/b"));
    expect(found[0].id).toMatch(/^a-[0-9a-f]{6}$/);
  });

  it("ignores depth 3, node_modules, hidden dirs and nested projects", async () => {
    mk("org/deep/c/.devcontainer", "devcontainer.json");
    mk("node_modules/x/.devcontainer", "devcontainer.json");
    mk(".hidden/y/.devcontainer", "devcontainer.json");
    mk("a/.devcontainer", "devcontainer.json");
    mk("a/sub/.devcontainer", "devcontainer.json");
    expect((await scanRoots([root])).map((p) => p.name)).toEqual(["a"]);
  });

  it("does not treat worktrees kept next to a project as projects", async () => {
    mk("a/.devcontainer", "devcontainer.json");
    mk("a.worktrees/feature-x/.devcontainer", "devcontainer.json");
    expect((await scanRoots([root])).map((p) => p.name)).toEqual(["a"]);
  });

  it("treats the root itself as a project when it has a spec", async () => {
    mk(".devcontainer", "devcontainer.json");
    expect((await scanRoots([root])).map((p) => p.path)).toEqual([root]);
  });

  it("does not treat an empty .devcontainer dir as a project", async () => {
    mk("a/.devcontainer");
    expect(await scanRoots([root])).toEqual([]);
  });

  it("dedupes overlapping roots", async () => {
    mk("org/b", ".devcontainer.json");
    const found = await scanRoots([root, path.join(root, "org")]);
    expect(found).toHaveLength(1);
  });

  it("warns once for a missing root and keeps scanning others", async () => {
    mk("a", ".devcontainer.json");
    const warn = vi.fn();
    const found = await scanRoots([path.join(root, "nope"), root], 2, warn);
    expect(found.map((p) => p.name)).toEqual(["a"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips unreadable subdirectories and does not follow symlink loops", async () => {
    mk("a", ".devcontainer.json");
    mk("locked/inner", ".devcontainer.json");
    fs.chmodSync(path.join(root, "locked"), 0o000);
    fs.symlinkSync(root, path.join(root, "loop"));
    const warn = vi.fn();
    const found = await scanRoots([root], 2, warn);
    fs.chmodSync(path.join(root, "locked"), 0o755);
    expect(found.map((p) => p.name)).toEqual(["a"]);
    expect(warn).not.toHaveBeenCalled();
  });
});
