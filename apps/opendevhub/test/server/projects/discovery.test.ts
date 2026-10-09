import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  scanCandidates,
  scanRoots,
} from "../../../src/server/projects/discovery";

let root: string;
function mk(rel: string, file?: string) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (file) {
    fs.writeFileSync(path.join(dir, file), "{}");
  }
}

/** A git repo: a .git folder, or a .git file as in submodules and linked worktrees. */
function git(rel: string, asFile = false) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (asFile) {
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere\n");
  } else {
    fs.mkdirSync(path.join(dir, ".git"));
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "odh-scan-"));
});
afterEach(() => {
  fs.chmodSync(root, 0o755);
  fs.rmSync(root, { recursive: true, force: true });
});

describe(scanRoots, () => {
  it("finds projects at depth 1 and 2 with either spec location", async () => {
    mk("a/.devcontainer", "devcontainer.json");
    mk("org/b", ".devcontainer.json");
    const found = await scanRoots([root]);
    expect(found.map((p) => p.name)).toStrictEqual(["a", "b"]);
    expect(found[0].devcontainerPath).toBe(
      path.join(root, "a/.devcontainer/devcontainer.json")
    );
    expect(found[1].path).toBe(path.join(root, "org/b"));
    expect(found[0].id).toMatch(/^a-[0-9a-f]{6}$/u);
  });

  it("ignores depth 3, node_modules, hidden dirs and nested projects", async () => {
    mk("org/deep/c/.devcontainer", "devcontainer.json");
    mk("node_modules/x/.devcontainer", "devcontainer.json");
    mk(".hidden/y/.devcontainer", "devcontainer.json");
    mk("a/.devcontainer", "devcontainer.json");
    mk("a/sub/.devcontainer", "devcontainer.json");
    expect((await scanRoots([root])).map((p) => p.name)).toStrictEqual(["a"]);
  });

  it("does not treat worktrees kept next to a project as projects", async () => {
    mk("a/.devcontainer", "devcontainer.json");
    mk("a.worktrees/feature-x/.devcontainer", "devcontainer.json");
    expect((await scanRoots([root])).map((p) => p.name)).toStrictEqual(["a"]);
  });

  it("treats the root itself as a project when it has a spec", async () => {
    mk(".devcontainer", "devcontainer.json");
    expect((await scanRoots([root])).map((p) => p.path)).toStrictEqual([root]);
  });

  it("does not treat an empty .devcontainer dir as a project", async () => {
    mk("a/.devcontainer");
    await expect(scanRoots([root])).resolves.toStrictEqual([]);
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
    expect(found.map((p) => p.name)).toStrictEqual(["a"]);
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
    expect(found.map((p) => p.name)).toStrictEqual(["a"]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe(scanCandidates, () => {
  it("lists git repos without a devcontainer at depth 1 and 2, with their root and stack", async () => {
    git("app");
    fs.writeFileSync(path.join(root, "app", "package.json"), "{}");
    git("org/svc", true);
    const found = await scanCandidates([root]);
    expect(found).toStrictEqual([
      { path: path.join(root, "app"), name: "app", root, stack: "node" },
      { path: path.join(root, "org/svc"), name: "svc", root, stack: "generic" },
    ]);
  });

  it("skips projects and everything inside them", async () => {
    git("proj");
    mk("proj/.devcontainer", "devcontainer.json");
    git("proj/vendored-submodule");
    git("other");
    mk("other", ".devcontainer.json");
    await expect(scanCandidates([root])).resolves.toStrictEqual([]);
  });

  it("does not descend into a candidate", async () => {
    git("mono");
    git("mono/nested");
    expect((await scanCandidates([root])).map((c) => c.name)).toStrictEqual([
      "mono",
    ]);
  });

  it("skips depth 3, node_modules, hidden dirs and worktree folders", async () => {
    git("org/deep/c");
    git("node_modules/x");
    git(".hidden/y");
    git("a.worktrees/feature");
    mk("plain/folder");
    await expect(scanCandidates([root])).resolves.toStrictEqual([]);
  });

  it("dedupes overlapping roots and keeps the first root a repo was found under", async () => {
    git("org/b");
    const found = await scanCandidates([root, path.join(root, "org")]);
    expect(found).toStrictEqual([
      { path: path.join(root, "org/b"), name: "b", root, stack: "generic" },
    ]);
  });

  it("warns once for a missing root", async () => {
    git("a");
    const warn = vi.fn();
    expect(
      (await scanCandidates([path.join(root, "nope"), root], 2, warn)).map(
        (c) => c.name
      )
    ).toStrictEqual(["a"]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
