import { describe, expect, it, vi } from "vitest";
import { type BranchGit, branchChanged, FRESH_IMAGE_MS, scanBranches, staleDocker } from "../../src/server/cleanup";
import type { ContainerInfo, ImageInfo } from "../../src/server/containers";
import type { BranchRef } from "../../src/server/git";
import type { BranchCleanupItem, Project, Worktree } from "../../src/shared/types";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const OLD = NOW - 2 * FRESH_IMAGE_MS;
const img = (id: string, refs: string[], extra: Partial<ImageInfo> = {}): ImageInfo => ({ id, refs, bytes: 100, created: OLD, labels: {}, ...extra });
const ctr = (id: string, extra: Partial<ContainerInfo>): ContainerInfo => ({ id, name: `n-${id}`, running: false, ...extra });

function stale(o: { containers?: ContainerInfo[]; images?: ImageInfo[]; envs?: string[]; refs?: string[] }) {
  return staleDocker({
    containers: o.containers ?? [],
    images: o.images ?? [],
    projects: new Set(["demo"]),
    hasEnv: (id) => (o.envs ?? []).includes(id),
    recordedRefs: new Set(o.refs ?? []),
    now: NOW,
  });
}

describe("staleDocker containers", () => {
  it("lists task containers without a record, and containers of removed projects", () => {
    const items = stale({
      containers: [
        ctr("c1", { envId: "demo-x", envProjectId: "demo" }),
        ctr("c2", { envId: "gone-y", envProjectId: "gone" }),
        ctr("c3", { envId: "gone-z", envProjectId: "gone", running: true }),
        ctr("c4", { projectId: "gone" }),
        ctr("c5", { projectId: "demo" }),
        ctr("c6", { envId: "demo-ok", envProjectId: "demo" }),
      ],
      envs: ["demo-ok", "gone-z"],
    });
    expect(items.map((i) => [i.id, i.kind === "container" && i.why, i.checked])).toEqual([
      ["container:c1", "orphan-env", true],
      ["container:c2", "orphan-env", true],
      ["container:c3", "removed-project", false],
      ["container:c4", "removed-project", true],
    ]);
    expect(items[0]).toMatchObject({ kind: "container", containerId: "c1", name: "n-c1", running: false, projectId: "demo" });
  });
});

describe("staleDocker images", () => {
  it("lists superseded bases, images of removed projects and unused labelled UID images", () => {
    const items = stale({
      images: [
        img("sha256:old", ["opendevhub/demo:111111111111-base"]),
        img("sha256:cur", ["opendevhub/demo:222222222222-base"]),
        img("sha256:gone", ["opendevhub/gone:333333333333-base"]),
        img("sha256:uid", ["vsc-demo-feat-abc-uid:latest"], { labels: { "opendevhub.base-project": "demo" } }),
        img("sha256:dangling", [], { labels: { "opendevhub.base-project": "demo" } }),
      ],
      refs: ["opendevhub/demo:222222222222-base"],
    });
    expect(items.map((i) => [i.id, i.kind === "image" && i.why, i.checked])).toEqual([
      ["image:opendevhub/demo:111111111111-base", "superseded", true],
      ["image:opendevhub/gone:333333333333-base", "removed-project", true],
      ["image:vsc-demo-feat-abc-uid:latest", "uid", true],
    ]);
    expect(items[0]).toMatchObject({ ref: "opendevhub/demo:111111111111-base", bytes: 100, projectId: "demo" });
  });

  it("keeps images a kept container runs, and offers ones only stale containers run", () => {
    const items = stale({
      containers: [ctr("keep", { projectId: "demo", imageId: "sha256:a" }), ctr("orphan", { envId: "demo-x", envProjectId: "demo", imageId: "sha256:b" })],
      images: [
        img("sha256:a", ["vsc-a-uid:latest"], { labels: { "opendevhub.base-project": "demo" } }),
        img("sha256:b", ["vsc-b-uid:latest"], { labels: { "opendevhub.base-project": "demo" } }),
      ],
    });
    expect(items.map((i) => i.id)).toEqual(["container:orphan", "image:vsc-b-uid:latest"]);
  });

  it("never offers an image created in the last 15 minutes", () => {
    const items = stale({ images: [img("sha256:new", ["opendevhub/demo:444444444444-base"], { created: NOW - 60_000 })] });
    expect(items).toEqual([]);
  });

  it("ignores opendevhub images that aren't bases of a current project", () => {
    expect(stale({ images: [img("sha256:x", ["opendevhub/demo:something"])] })).toEqual([]);
  });
});

const project: Project = { id: "demo", name: "demo", path: "/src/demo", devcontainerPath: "/x" };
const WS = "/workspaces/demo";

/** A repo: refs, which branches are in which base, recorded bases, dirty worktree paths. */
function repo(o: {
  refs: BranchRef[];
  merged?: Record<string, string[]>;
  recorded?: Record<string, string>;
  dirty?: string[];
  current?: string;
  remotes?: string[];
  remoteHead?: string;
  fetchFails?: string;
}) {
  const git = {
    remotes: vi.fn(async () => o.remotes ?? ["origin"]),
    fetchPrune: vi.fn(async () => {
      if (o.fetchFails) throw new Error(o.fetchFails);
    }),
    branchRefs: vi.fn(async () => o.refs),
    remoteHead: vi.fn(async () => o.remoteHead),
    currentBranch: vi.fn(async () => o.current ?? "main"),
    recordedBase: vi.fn(async (_p: Project, _d: string, b: string) => o.recorded?.[b]),
    isAncestor: vi.fn(async (_p: Project, _d: string, b: string, base: string) => {
      const inBase = o.merged?.[base];
      if (!inBase) throw new Error(`fatal: Not a valid object name ${base}`);
      return inBase.includes(b);
    }),
    isClean: vi.fn(async (_p: Project, dir: string) => !(o.dirty ?? []).includes(dir)),
  } satisfies BranchGit;
  return git;
}
const ref = (name: string, extra: Partial<BranchRef> = {}): BranchRef => ({ name, gone: false, ...extra });
const wt = (branch: string): Worktree => ({ path: `/workspaces/demo.worktrees/${branch}`, branch });

describe("scanBranches", () => {
  it("lists merged branches checked and upstream-gone ones unchecked, skipping the base and the current branch", async () => {
    const git = repo({
      refs: [ref("main"), ref("feat"), ref("squashed", { upstream: "refs/remotes/origin/squashed", gone: true }), ref("wip"), ref("live", { upstream: "refs/remotes/origin/live" })],
      merged: { main: ["main", "feat"] },
      remoteHead: "main",
    });
    const r = await scanBranches(git, { project, workspace: WS, worktrees: [wt("feat")], envOf: (p) => (p.endsWith("/feat") ? "env-feat" : undefined) });
    expect(git.fetchPrune).toHaveBeenCalledWith(project, WS, "origin");
    expect(r.warning).toBeUndefined();
    expect(r.items).toEqual([
      { id: "branch:demo:feat", kind: "branch", checked: true, reason: "merged into main", projectId: "demo", branch: "feat", base: "main", why: "merged",
        worktree: "/workspaces/demo.worktrees/feat", env: "env-feat" },
      { id: "branch:demo:squashed", kind: "branch", checked: false, reason: "its upstream is gone; it may not be merged", projectId: "demo",
        branch: "squashed", base: "main", why: "upstream-gone" },
    ]);
  });

  it("uses each branch's recorded base, then the remote HEAD, then the current branch", async () => {
    const git = repo({ refs: [ref("dev"), ref("a"), ref("b")], recorded: { a: "dev" }, merged: { dev: ["a"], trunk: ["b"] }, current: "trunk", remotes: [] });
    const r = await scanBranches(git, { project, workspace: WS, worktrees: [], envOf: () => undefined });
    expect(git.fetchPrune).not.toHaveBeenCalled();
    expect(r.items.map((i) => [i.branch, i.base])).toEqual([["a", "dev"], ["b", "trunk"]]);
  });

  it("keeps scanning on local refs when the fetch fails", async () => {
    const git = repo({ refs: [ref("feat")], merged: { main: ["feat"] }, remoteHead: "main", fetchFails: "could not read from remote" });
    const r = await scanBranches(git, { project, workspace: WS, worktrees: [], envOf: () => undefined });
    expect(r.warning).toBe("using local refs: could not read from remote");
    expect(r.items.map((i) => i.branch)).toEqual(["feat"]);
  });

  it("skips a branch whose base is missing, and goes on with the rest", async () => {
    const git = repo({ refs: [ref("orphan"), ref("feat")], recorded: { orphan: "deleted-base" }, merged: { main: ["feat"] }, remoteHead: "main" });
    const r = await scanBranches(git, { project, workspace: WS, worktrees: [], envOf: () => undefined });
    expect(r.items.map((i) => i.branch)).toEqual(["feat"]);
  });

  it("marks a dirty worktree and leaves it unchecked", async () => {
    const git = repo({ refs: [ref("feat")], merged: { main: ["feat"] }, remoteHead: "main", dirty: ["/workspaces/demo.worktrees/feat"] });
    const r = await scanBranches(git, { project, workspace: WS, worktrees: [wt("feat")], envOf: () => undefined });
    expect(r.items[0]).toMatchObject({ dirty: true, checked: false });
  });
});

describe("branchChanged", () => {
  const item = (extra: Partial<BranchCleanupItem> = {}): BranchCleanupItem => ({
    id: "branch:demo:feat", kind: "branch", checked: true, reason: "merged into main", projectId: "demo", branch: "feat", base: "main", why: "merged", ...extra,
  });

  it("passes a branch that still qualifies", async () => {
    const git = repo({ refs: [ref("feat")], merged: { main: ["feat"] }, remoteHead: "main" });
    expect(await branchChanged(git, project, WS, item(), [])).toBeUndefined();
    expect(git.fetchPrune).not.toHaveBeenCalled();
  });

  it("recomputes the base instead of trusting the request", async () => {
    const git = repo({ refs: [ref("feat")], merged: { main: [], feat: ["feat"] }, remoteHead: "main" });
    expect(await branchChanged(git, project, WS, item({ base: "feat" }), [])).toBe("changed since scan");
  });

  it("refuses an upstream-gone claim when the upstream is still there", async () => {
    const git = repo({ refs: [ref("feat", { upstream: "refs/remotes/origin/feat" })], merged: { main: [] }, remoteHead: "main" });
    expect(await branchChanged(git, project, WS, item({ why: "upstream-gone" }), [])).toBe("changed since scan");
  });

  it("accepts an upstream-gone branch that has since been merged", async () => {
    const git = repo({ refs: [ref("feat", { upstream: "refs/remotes/origin/feat", gone: true })], merged: { main: ["feat"] }, remoteHead: "main" });
    expect(await branchChanged(git, project, WS, item({ why: "upstream-gone" }), [])).toBeUndefined();
  });

  it("skips a branch that is gone or now checked out in the main checkout", async () => {
    expect(await branchChanged(repo({ refs: [] }), project, WS, item(), [])).toBe("the branch no longer exists");
    const git = repo({ refs: [ref("feat")], merged: { feat: ["feat"] }, current: "feat" });
    expect(await branchChanged(git, project, WS, item(), [])).toBe("the branch is checked out in the main checkout");
  });

  it("skips when the worktree changed or got uncommitted changes since the scan", async () => {
    const base = { refs: [ref("feat")], merged: { main: ["feat"] }, remoteHead: "main" };
    expect(await branchChanged(repo(base), project, WS, item(), [wt("feat")])).toBe("changed since scan");
    const dirty = repo({ ...base, dirty: ["/workspaces/demo.worktrees/feat"] });
    expect(await branchChanged(dirty, project, WS, item({ worktree: wt("feat").path }), [wt("feat")])).toBe(
      "changed since scan: the worktree has uncommitted changes",
    );
    expect(await branchChanged(dirty, project, WS, item({ worktree: wt("feat").path, dirty: true }), [wt("feat")])).toBeUndefined();
  });
});
