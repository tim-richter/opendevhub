import { describe, expect, it, vi } from "vitest";
import { type BranchGit, branchChanged, Cleanup, FRESH_IMAGE_MS, parseCleanupItems, scanBranches, staleDocker, staleSessions } from "../../src/server/cleanup";
import type { ContainerInfo, ImageInfo } from "../../src/server/containers";
import type { BranchRef } from "../../src/server/git";
import type { RawSession } from "../../src/server/opencode/client";
import { BusyError } from "../../src/server/orchestrator";
import { StateStore } from "../../src/server/state";
import { InvalidRequestError } from "../../src/server/worktrees";
import { rawSession } from "../helpers/fake-opencode";
import type { BranchCleanupItem, CleanupItem, Project, SessionCleanupItem, Worktree } from "../../src/shared/types";

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

function service(o: { containers?: ContainerInfo[]; images?: ImageInfo[]; running?: boolean } = {}) {
  const store = new StateStore({ port: 0, persisted: { projects: {} }, persist: () => {} });
  store.setProjects([project]);
  store.updateRuntime(project.id, { containerState: o.running === false ? "stopped" : "running" });
  let containerList = o.containers ?? [];
  let imageList = o.images ?? [];
  const order: string[] = [];
  const containers = {
    listManaged: vi.fn(async () => containerList),
    listImages: vi.fn(async (_f: string[]) => imageList),
    remove: vi.fn(async (id: string) => {
      order.push(`container:${id}`);
      containerList = containerList.filter((c) => c.id !== id);
    }),
    removeImage: vi.fn(async (ref: string) => {
      imageList = imageList.filter((i) => !i.refs.includes(ref));
      return true;
    }),
  };
  const branches = {
    cleanupScan: vi.fn(async (_id: string) => ({ items: [branchItem] as BranchCleanupItem[] }) as { warning?: string; items: BranchCleanupItem[] }),
    cleanupBranch: vi.fn(async (_id: string, item: BranchCleanupItem) => {
      order.push(item.id);
      return { outcome: "removed" as const };
    }),
    cleanupSessionScan: vi.fn(async (_id: string) => ({ items: [sessionItem] as SessionCleanupItem[] }) as { warning?: string; items: SessionCleanupItem[] }),
    cleanupSession: vi.fn(async (_id: string, item: SessionCleanupItem) => {
      order.push(item.id);
      return { outcome: "removed" as const };
    }),
    appendLog: vi.fn((_id: string, _line: string) => {}),
  };
  const cleanup = new Cleanup({ store, containers, branches, now: () => NOW });
  return { cleanup, containers, branches, store, order };
}
const branchItem: BranchCleanupItem = {
  id: "branch:demo:feat", kind: "branch", checked: true, reason: "merged into main", projectId: "demo", branch: "feat", base: "main", why: "merged",
};
const sessionItem: SessionCleanupItem = {
  id: "session:demo:ses_d", kind: "session", checked: true, reason: "discarded task variant", projectId: "demo", sessionId: "ses_d",
  title: "t", directory: "/workspaces/demo", updatedAt: NOW, why: "discarded",
};
const orphan = ctr("c1", { envId: "demo-x", envProjectId: "demo", imageId: "sha256:uid" });
const uidImage = img("sha256:uid", ["vsc-x-uid:latest"], { labels: { "opendevhub.base-project": "demo" } });

describe("Cleanup.scan", () => {
  it("combines each project's branches with the Docker items", async () => {
    const { cleanup, containers } = service({ containers: [orphan], images: [uidImage] });
    const plan = await cleanup.scan();
    expect(containers.listImages).toHaveBeenCalledWith(["reference=opendevhub/*", "label=opendevhub.base-project"]);
    expect(plan).toMatchObject({ scannedAt: NOW, projects: [{ id: "demo", name: "demo" }] });
    expect(plan.items.map((i) => i.id)).toEqual(["branch:demo:feat", "session:demo:ses_d", "container:c1", "image:vsc-x-uid:latest"]);
  });

  it("scans sessions after branches, and still scans them when the branch scan fails", async () => {
    const { cleanup, branches } = service();
    const calls: string[] = [];
    branches.cleanupScan.mockImplementation(async () => {
      calls.push("branches");
      throw new BusyError("demo");
    });
    branches.cleanupSessionScan.mockImplementation(async () => {
      calls.push("sessions");
      return { warning: "demo-feat: opencode is not running", items: [sessionItem] };
    });
    const plan = await cleanup.scan();
    expect(calls).toEqual(["branches", "sessions"]);
    expect(plan.items.map((i) => i.id)).toEqual(["session:demo:ses_d"]);
    expect(plan.projects[0].warning).toBe("busy with another git action; scan again in a moment; demo-feat: opencode is not running");
    branches.cleanupSessionScan.mockRejectedValue(new Error("boom"));
    expect((await cleanup.scan()).projects[0].warning).toContain("could not scan sessions: boom");
  });

  it("skips branches of a stopped project but still scans Docker", async () => {
    const { cleanup, branches } = service({ running: false, containers: [orphan] });
    const plan = await cleanup.scan();
    expect(branches.cleanupScan).not.toHaveBeenCalled();
    expect(branches.cleanupSessionScan).not.toHaveBeenCalled();
    expect(plan.projects).toEqual([{ id: "demo", name: "demo", skipped: "not running" }]);
    expect(plan.items.map((i) => i.id)).toEqual(["container:c1"]);
  });

  it("shows a busy or failing project as a warning", async () => {
    const { cleanup, branches } = service();
    branches.cleanupScan.mockImplementation(() => {
      throw new BusyError("demo");
    });
    expect((await cleanup.scan()).projects[0].warning).toBe("busy with another git action; scan again in a moment");
    branches.cleanupScan.mockRejectedValue(new Error("boom"));
    expect((await cleanup.scan()).projects[0].warning).toBe("could not scan branches: boom");
  });

  it("reports Docker being unreachable without losing the branches", async () => {
    const { cleanup, containers } = service();
    containers.listManaged.mockRejectedValue(new Error("Cannot connect to the Docker daemon"));
    const plan = await cleanup.scan();
    expect(plan.dockerError).toBe("Cannot connect to the Docker daemon");
    expect(plan.items.map((i) => i.id)).toEqual(["branch:demo:feat", "session:demo:ses_d"]);
  });
});

describe("Cleanup.apply", () => {
  it("removes branches, then sessions, then containers, then the images they freed", async () => {
    const { cleanup, containers, order } = service({ containers: [orphan], images: [uidImage] });
    const plan = await cleanup.scan();
    const result = await cleanup.apply(plan.items);
    expect(order).toEqual(["branch:demo:feat", "session:demo:ses_d", "container:c1"]);
    expect(containers.removeImage).toHaveBeenCalledWith("vsc-x-uid:latest");
    expect(result).toEqual({
      results: [
        { id: "branch:demo:feat", outcome: "removed" },
        { id: "session:demo:ses_d", outcome: "removed" },
        { id: "container:c1", outcome: "removed" },
        { id: "image:vsc-x-uid:latest", outcome: "removed" },
      ],
      freedBytes: 100,
    });
  });

  it("skips an image a kept container started using since the scan", async () => {
    const { cleanup, containers } = service({ images: [uidImage] });
    const plan = await cleanup.scan();
    containers.listManaged.mockResolvedValue([ctr("new", { projectId: "demo", imageId: "sha256:uid" })]);
    const result = await cleanup.apply(plan.items.filter((i) => i.kind === "image"));
    expect(result.results).toEqual([{ id: "image:vsc-x-uid:latest", outcome: "skipped", message: "in use, or already gone" }]);
    expect(containers.removeImage).not.toHaveBeenCalled();
  });

  it("never removes a Docker item the fresh scan doesn't list, whatever the request says", async () => {
    const { cleanup, containers } = service({ containers: [ctr("kept", { projectId: "demo" })] });
    const forged: CleanupItem = { id: "container:kept", kind: "container", checked: true, reason: "x", containerId: "kept", running: false, why: "orphan-env" };
    const result = await cleanup.apply([forged]);
    expect(result.results[0]).toMatchObject({ outcome: "skipped" });
    expect(containers.remove).not.toHaveBeenCalled();
  });

  it("goes on after a failure, and maps a busy project to skipped", async () => {
    const { cleanup, branches, containers } = service({ containers: [orphan] });
    branches.cleanupBranch.mockImplementationOnce(() => {
      throw new BusyError("demo");
    });
    containers.remove.mockRejectedValueOnce(new Error("docker rm failed: boom"));
    const plan = await cleanup.scan();
    const result = await cleanup.apply(plan.items.filter((i) => i.kind !== "image" && i.kind !== "session"));
    expect(result.results).toEqual([
      { id: "branch:demo:feat", outcome: "skipped", message: "project busy" },
      { id: "container:c1", outcome: "failed", message: "docker rm failed: boom" },
    ]);
    expect(branches.appendLog).toHaveBeenCalledWith("demo", "cleanup: could not remove container n-c1: docker rm failed: boom");
  });

  it("reports a session that failed to go, and logs it to its project", async () => {
    const { cleanup, branches } = service();
    branches.cleanupSession.mockRejectedValueOnce(new Error("opencode is not running — start the project first"));
    const result = await cleanup.apply([sessionItem]);
    expect(result.results).toEqual([{ id: "session:demo:ses_d", outcome: "failed", message: "opencode is not running — start the project first" }]);
    expect(branches.appendLog).toHaveBeenCalledWith("demo", "cleanup: could not remove session ses_d: opencode is not running — start the project first");
  });

  it("logs Docker removals to the owning project", async () => {
    const { cleanup, branches } = service({ containers: [orphan] });
    await cleanup.apply((await cleanup.scan()).items.filter((i) => i.kind === "container"));
    expect(branches.appendLog).toHaveBeenCalledWith("demo", "cleanup: removed container n-c1 (opendevhub has no record of its worktree environment)");
  });

  it("runs one apply at a time", async () => {
    const { cleanup, branches } = service();
    let release!: () => void;
    branches.cleanupBranch.mockImplementation(() => new Promise((r) => (release = () => r({ outcome: "removed" }))));
    const first = cleanup.apply([branchItem]);
    await expect(cleanup.apply([branchItem])).rejects.toThrow(BusyError);
    await vi.waitFor(() => expect(release).toBeDefined());
    release();
    await first;
  });
});

describe("parseCleanupItems", () => {
  it("keeps the identity fields and drops the rest", () => {
    expect(parseCleanupItems([{ ...branchItem, extra: 1 }, { kind: "container", containerId: "c1" }, { kind: "image", ref: "opendevhub/demo:1-base" }, { ...sessionItem, envId: "demo-feat", title: "forged" }])).toEqual([
      { id: "branch:demo:feat", kind: "branch", checked: true, reason: "merged into main", projectId: "demo", branch: "feat", base: "main", why: "merged" },
      { id: "container:c1", kind: "container", checked: true, reason: "", containerId: "c1", running: false, why: "orphan-env" },
      { id: "image:opendevhub/demo:1-base", kind: "image", checked: true, reason: "", ref: "opendevhub/demo:1-base", bytes: 0, why: "superseded" },
      { id: "session:demo:ses_d", kind: "session", checked: true, reason: "", projectId: "demo", envId: "demo-feat", sessionId: "ses_d", title: "", directory: "", updatedAt: 0, why: "idle" },
    ]);
  });

  it("rejects what isn't a list of known items", () => {
    expect(() => parseCleanupItems("x")).toThrow(InvalidRequestError);
    expect(() => parseCleanupItems([{ kind: "volume" }])).toThrow(InvalidRequestError);
    expect(() => parseCleanupItems([{ kind: "branch", projectId: "demo", branch: "-x", why: "merged" }])).toThrow(InvalidRequestError);
    expect(() => parseCleanupItems([{ kind: "branch", projectId: "demo", branch: "x", why: "whatever" }])).toThrow(InvalidRequestError);
    expect(() => parseCleanupItems([{ kind: "session", projectId: "demo" }])).toThrow(InvalidRequestError);
  });
});

describe("staleSessions", () => {
  const DAY = 24 * 60 * 60_000;
  const recent = { created: NOW - DAY, updated: NOW - DAY };
  const at = (directory: string) => ({ directory });
  const scan = (sessions: RawSession[], busy: string[] = []) =>
    staleSessions({
      projectId: "demo",
      sessions,
      busy: new Set(busy),
      workspace: "/workspaces/demo",
      worktrees: ["/workspaces/demo.worktrees/feat"],
      now: NOW,
    });

  it("lists discarded variants and sessions of removed worktrees checked, long-idle ones unchecked", () => {
    const items = scan([
      rawSession("ses_d", { time: recent, location: at("/workspaces/demo.worktrees/feat"), metadata: { opendevhub: { task: "tsk_1", variant: 2, of: 2, title: "t", discarded: true } } }),
      rawSession("ses_g", { time: recent, location: at("/workspaces/demo.worktrees/gone") }),
      rawSession("ses_i", { time: { created: 0, updated: NOW - 40 * DAY }, location: at("/workspaces/demo/sub") }),
      rawSession("ses_ok", { time: recent, location: at("/workspaces/demo") }),
      rawSession("ses_wt", { time: recent, location: at("/workspaces/demo.worktrees/feat/pkg") }),
    ]);
    expect(items.map((i) => [i.id, i.why, i.checked, i.reason])).toEqual([
      ["session:demo:ses_d", "discarded", true, "discarded task variant"],
      ["session:demo:ses_g", "worktree-gone", true, "its worktree was removed"],
      ["session:demo:ses_i", "idle", false, "idle for 40 days"],
    ]);
    expect(items[1]).toMatchObject({ kind: "session", projectId: "demo", sessionId: "ses_g", title: "Session ses_g", directory: "/workspaces/demo.worktrees/gone", updatedAt: NOW - DAY });
  });

  it("never lists subagents, archived sessions, or a session whose tree is busy; idle counts the newest update in the tree", () => {
    const old = { created: 0, updated: NOW - 40 * DAY };
    const items = scan(
      [
        rawSession("ses_a", { time: old }),
        rawSession("ses_a1", { time: old, parentID: "ses_a" }),
        rawSession("ses_b", { time: old }),
        rawSession("ses_b1", { time: recent, parentID: "ses_b" }),
        rawSession("ses_c", { time: { ...old, archived: NOW - 40 * DAY } }),
        rawSession("ses_e", { time: old, location: at("/workspaces/demo.worktrees/gone") }),
      ],
      ["ses_a1", "ses_e"],
    );
    expect(items).toEqual([]);
  });

  it("lists no session as of a removed worktree when the worktree list is unknown", () => {
    const items = staleSessions({
      projectId: "demo",
      sessions: [rawSession("ses_g", { time: recent, location: at("/workspaces/demo.worktrees/feat") })],
      busy: new Set(),
      workspace: "/workspaces/demo",
      now: NOW,
    });
    expect(items).toEqual([]);
  });

  it("names the task environment that holds the session", () => {
    const items = staleSessions({
      projectId: "demo",
      envId: "demo-feat",
      sessions: [rawSession("ses_g", { time: recent, location: at("/x") })],
      busy: new Set(),
      workspace: "/workspaces/demo",
      worktrees: [],
      now: NOW,
    });
    expect(items).toMatchObject([{ id: "session:demo:ses_g", envId: "demo-feat" }]);
  });
});
