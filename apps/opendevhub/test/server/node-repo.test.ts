import { describe, expect, it } from "vitest";
import { NodeRepo } from "../../src/server/node-repo";
import type { Project } from "../../src/shared/types";
import { type Call, fakeRunner } from "../helpers/fake-runner";

const project: Project = { id: "demo-abc123", name: "demo", path: "/src/demo", devcontainerPath: "/src/demo/.devcontainer/devcontainer.json" };
const target = { dest: "tim@box", control: "/home/me/.config/opendevhub/ssh dir/box.sock" };
const SSH = { GIT_SSH_COMMAND: "ssh -S '/home/me/.config/opendevhub/ssh dir/box.sock' -o BatchMode=yes", GIT_TERMINAL_PROMPT: "0" };

function setup(remote: (c: Call) => object = () => ({}), local: (c: Call) => object = () => ({})) {
  const node = fakeRunner(remote);
  const hub = fakeRunner(local);
  const repo = new NodeRepo({ node: "box", host: { run: node.run, home: "/home/tim" }, target, local: hub.run });
  return { repo, node, hub, layout: repo.layout(project, "/workspaces/demo") };
}

describe("NodeRepo", () => {
  it("lays the repository out so relative worktree links match the containers", () => {
    expect(setup().layout).toEqual({
      repo: "/home/tim/.opendevhub/repos/demo-abc123/demo",
      gitDir: "/home/tim/.opendevhub/repos/demo-abc123/demo/.git",
      worktrees: "/home/tim/.opendevhub/repos/demo-abc123/demo.worktrees",
      url: "ssh://tim@box/home/tim/.opendevhub/repos/demo-abc123/demo",
      workspaceFolder: "/workspaces/demo",
    });
  });

  it("creates the repository once, never checked out", async () => {
    const { repo, node, layout } = setup();
    await repo.ensure(layout);
    expect(node.calls[0].cmd).toBe("sh");
    expect(node.calls[0].args[1]).toContain("git init -q");
    expect(node.calls[0].args[1]).toContain("receive.denyCurrentBranch ignore");
    expect(node.calls[0].args.slice(2)).toEqual(["sh", layout.repo]);
    const broken = setup(() => ({ exitCode: 1, stderr: "mkdir: Permission denied\n" }));
    await expect(broken.repo.ensure(broken.layout)).rejects.toThrow(/preparing .* on box failed: mkdir: Permission denied/);
  });

  it("lists branches, and none before the repository exists", async () => {
    const { repo, layout } = setup(() => ({ stdout: "fix\nmain\n" }));
    expect(await repo.branches(layout)).toEqual(["fix", "main"]);
    const empty = setup(() => ({ exitCode: 128, stderr: "fatal: cannot change to '/home/tim/…': No such file or directory\n" }));
    expect(await empty.repo.branches(empty.layout)).toEqual([]);
  });

  it("pushes the base from this machine through the master, slashes and all", async () => {
    const { repo, hub, layout } = setup();
    await repo.pushBase(project, layout, "origin/main");
    expect(hub.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/src/demo", "push", "--no-verify", "--quiet", layout.url, "+origin/main:refs/heads/origin/main"],
      opts: { env: SSH, timeoutMs: 120_000, detached: true },
    });
    const failing = setup(undefined, () => ({ exitCode: 128, stderr: "fatal: Could not read from remote repository.\n" }));
    await expect(failing.repo.pushBase(project, failing.layout, "main")).rejects.toThrow(/pushing main to box failed: fatal: Could not read/);
  });

  it("adds a worktree with relative links and records its base", async () => {
    const { repo, node, layout } = setup();
    expect(await repo.addWorktree(layout, "feature/x", "main")).toEqual({
      path: "/workspaces/demo.worktrees/feature-x",
      hostPath: "/home/tim/.opendevhub/repos/demo-abc123/demo.worktrees/feature-x",
      branch: "feature/x",
    });
    expect(node.calls.map((c) => c.args)).toEqual([
      ["-C", layout.repo, "worktree", "add", "--relative-paths", "-b", "feature/x", "--", `${layout.worktrees}/feature-x`, "main"],
      ["-C", layout.repo, "config", "branch.feature/x.opendevhubBase", "main"],
    ]);
  });

  it("removes a worktree and its branch, pruning one that is already gone", async () => {
    const { repo, node, layout } = setup((c) =>
      c.args.includes("remove") ? { exitCode: 128, stderr: "fatal: '/x' is not a working tree\n" } : {},
    );
    const wt = { path: "/workspaces/demo.worktrees/fix", hostPath: `${layout.worktrees}/fix`, branch: "fix" };
    await repo.removeWorktree(layout, wt);
    expect(node.calls.map((c) => c.args.slice(2))).toEqual([
      ["worktree", "remove", "--force", "--", wt.hostPath],
      ["worktree", "prune"],
      ["branch", "-D", "fix"],
    ]);
  });

  describe("bringHome", () => {
    const incoming = "refs/odh/incoming/fix";
    const script = (answers: Record<string, object>) => (c: Call) => answers[c.args[2]] ?? {};

    it("fetches into a temporary ref and moves a fresh branch onto it", async () => {
      const { repo, hub, layout } = setup(undefined, script({ "rev-parse": { exitCode: 1 } }));
      await repo.bringHome(project, layout, "fix");
      expect(hub.calls.map((c) => c.args.slice(2))).toEqual([
        ["fetch", "--no-tags", "--quiet", layout.url, `+refs/heads/fix:${incoming}`],
        ["rev-parse", "--verify", "-q", "refs/heads/fix"],
        ["update-ref", "refs/heads/fix", incoming],
        ["update-ref", "-d", incoming],
      ]);
      expect(hub.calls[0].opts?.env).toEqual(SSH);
    });

    it("fast-forwards a local branch that is behind", async () => {
      const { repo, hub, layout } = setup(undefined, script({ "symbolic-ref": { stdout: "main\n" } }));
      await repo.bringHome(project, layout, "fix");
      expect(hub.calls.map((c) => c.args[2])).toEqual(["fetch", "rev-parse", "symbolic-ref", "merge-base", "update-ref", "update-ref"]);
    });

    it("refuses a diverged or checked-out local branch and leaves it alone", async () => {
      const diverged = setup(undefined, script({ "symbolic-ref": { stdout: "main\n" }, "merge-base": { exitCode: 1 } }));
      await expect(diverged.repo.bringHome(project, diverged.layout, "fix")).rejects.toThrow("local branch fix has diverged from the one on box");
      expect(diverged.hub.calls.filter((c) => c.args[2] === "update-ref").map((c) => c.args.slice(3))).toEqual([["-d", incoming]]);

      const current = setup(undefined, script({ "symbolic-ref": { stdout: "fix\n" } }));
      await expect(current.repo.bringHome(project, current.layout, "fix")).rejects.toThrow(/fix is checked out in the main checkout/);
    });

    it("reports a fetch that fails", async () => {
      const { repo, layout } = setup(undefined, script({ fetch: { exitCode: 128, stderr: "fatal: couldn't find remote ref refs/heads/fix\n" } }));
      await expect(repo.bringHome(project, layout, "fix")).rejects.toThrow(/fetching fix from box failed: fatal: couldn't find remote ref/);
    });
  });
});
