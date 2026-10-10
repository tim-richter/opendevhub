// oxlint-disable no-shadow
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Containers } from "../../../src/server/environments/containers";
import { CommandError } from "../../../src/server/environments/containers";
import {
  GitOps,
  IDENTITY_HINT,
  hostHeadObjects,
  parseAheadBehind,
  parseBranchRefs,
} from "../../../src/server/git/ops";
import { spawnRunner } from "../../../src/server/nodes/exec";
import type { RunResult } from "../../../src/server/nodes/exec";
import type { Project } from "../../../src/shared/types";
import { fakeRunner } from "../../helpers/fake-runner";

const project: Project = {
  id: "p",
  name: "p",
  path: "/p",
  devcontainerPath: "/p/x",
};
let tmp: string;
let repo: string;
let env: Record<string, string>;
let ops: GitOps;

/** Runs the "container" command on this machine, isolated from the user's git config. */
const localContainers = () => ({
  exec: (_p: Project, command: string[], o?: { timeoutMs?: number }) =>
    spawnRunner(command[0], command.slice(1), {
      timeoutMs: o?.timeoutMs,
      env,
    }),
});
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
const write = (dir: string, file: string, text: string) =>
  fs.writeFileSync(path.join(dir, file), text);
const commitAll = (dir: string, msg: string) => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", msg);
};

describe("git", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-git-"));
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    env = { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@t");
    write(repo, "a.txt", "one\ntwo\nthree\n");
    commitAll(repo, "init");
    ops = new GitOps({ containers: localContainers() });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  describe(parseAheadBehind, () => {
    it("reads behind then ahead", () => {
      expect(parseAheadBehind("3\t1\n")).toStrictEqual({ behind: 3, ahead: 1 });
      expect(parseAheadBehind("")).toStrictEqual({ behind: 0, ahead: 0 });
    });
  });

  describe(GitOps, () => {
    it("reads the branch, the recorded base and ahead/behind", async () => {
      git(repo, "checkout", "-q", "-b", "feature");
      git(repo, "config", "branch.feature.opendevhubBase", "main");
      write(repo, "b.txt", "b\n");
      commitAll(repo, "b");
      write(repo, "c.txt", "c\n");
      commitAll(repo, "c");
      git(repo, "checkout", "-q", "main");
      write(repo, "d.txt", "d\n");
      commitAll(repo, "d");
      git(repo, "checkout", "-q", "feature");
      await expect(ops.currentBranch(project, repo)).resolves.toBe("feature");
      await expect(ops.recordedBase(project, repo, "feature")).resolves.toBe(
        "main"
      );
      await expect(
        ops.recordedBase(project, repo, "main")
      ).resolves.toBeUndefined();
      await expect(
        ops.aheadBehind(project, repo, "main")
      ).resolves.toStrictEqual({
        ahead: 2,
        behind: 1,
      });
      git(repo, "checkout", "-q", "--detach");
      await expect(ops.currentBranch(project, repo)).resolves.toBeUndefined();
    });

    it("reads the commit checked out", async () => {
      await expect(ops.head(project, repo)).resolves.toBe(
        git(repo, "rev-parse", "HEAD").trim()
      );
    });

    it("knows whether the checkout is clean and whether the branch was pushed", async () => {
      await expect(ops.isClean(project, repo)).resolves.toBeTruthy();
      write(repo, "new.txt", "x\n");
      await expect(ops.isClean(project, repo)).resolves.toBeFalsy();
      git(repo, "checkout", "-q", "-b", "feature");
      await expect(ops.isPushed(project, repo, "feature")).resolves.toBeFalsy();
      git(repo, "config", "branch.feature.opendevhubPublished", "true");
      await expect(
        ops.isPushed(project, repo, "feature")
      ).resolves.toBeTruthy();
      git(repo, "config", "--unset", "branch.feature.opendevhubPublished");
      git(repo, "branch", "-q", "--set-upstream-to=main", "feature");
      await expect(
        ops.isPushed(project, repo, "feature")
      ).resolves.toBeTruthy();
    });

    it("commits everything, untracked files included", async () => {
      write(repo, "new.txt", "x\n");
      write(repo, "a.txt", "changed\n");
      await ops.commit(project, repo, "feat: add new");
      expect(git(repo, "log", "-1", "--format=%s").trim()).toBe(
        "feat: add new"
      );
      await expect(ops.isClean(project, repo)).resolves.toBeTruthy();
    });

    it("commits only the changes under the paths it's given", async () => {
      fs.mkdirSync(path.join(repo, "openspec/changes/x"), { recursive: true });
      write(repo, "openspec/changes/x/proposal.md", "## Why\n");
      write(repo, "a.txt", "changed\n");
      await expect(
        ops.isClean(project, repo, ["openspec"])
      ).resolves.toBeFalsy();
      await ops.commit(project, repo, "docs: propose x", ["openspec"]);
      expect(git(repo, "show", "--name-only", "--format=", "HEAD").trim()).toBe(
        "openspec/changes/x/proposal.md"
      );
      await expect(
        ops.isClean(project, repo, ["openspec"])
      ).resolves.toBeTruthy();
      await expect(ops.isClean(project, repo)).resolves.toBeFalsy();
    });

    it("refuses to commit without an identity and says how to fix it", async () => {
      git(repo, "config", "--unset", "user.name");
      git(repo, "config", "--unset", "user.email");
      write(repo, "new.txt", "x\n");
      const err = await ops
        .commit(project, repo, "x")
        .catch((error: unknown) => error);
      expect(err).toBeInstanceOf(CommandError);
      expect((err as Error).message).toBe(IDENTITY_HINT);
    });

    it("rebases onto the base, or merges it into a pushed branch", async () => {
      git(repo, "checkout", "-q", "-b", "feature");
      write(repo, "b.txt", "b\n");
      commitAll(repo, "b");
      git(repo, "checkout", "-q", "main");
      write(repo, "c.txt", "c\n");
      commitAll(repo, "c");
      git(repo, "checkout", "-q", "feature");
      await expect(
        ops.update(project, repo, "main", "rebase")
      ).resolves.toStrictEqual({
        strategy: "rebase",
      });
      await expect(
        ops.aheadBehind(project, repo, "main")
      ).resolves.toStrictEqual({
        ahead: 1,
        behind: 0,
      });
      git(repo, "checkout", "-q", "main");
      write(repo, "d.txt", "d\n");
      commitAll(repo, "d");
      git(repo, "checkout", "-q", "feature");
      await expect(
        ops.update(project, repo, "main", "merge")
      ).resolves.toStrictEqual({
        strategy: "merge",
      });
      expect(
        git(repo, "log", "-1", "--format=%p").trim().split(" ")
      ).toHaveLength(2);
    });

    it.each(["rebase", "merge"] as const)(
      "aborts a conflicting %s and lists the files, leaving the branch as it was",
      async (strategy) => {
        git(repo, "checkout", "-q", "-b", "feature");
        write(repo, "a.txt", "one\nTWO feature\nthree\n");
        commitAll(repo, "feature two");
        const before = git(repo, "rev-parse", "HEAD");
        git(repo, "checkout", "-q", "main");
        write(repo, "a.txt", "one\nTWO main\nthree\n");
        commitAll(repo, "main two");
        git(repo, "checkout", "-q", "feature");
        await expect(
          ops.update(project, repo, "main", strategy)
        ).resolves.toStrictEqual({ strategy, conflicts: ["a.txt"] });
        expect(git(repo, "rev-parse", "HEAD")).toBe(before);
        expect(
          fs.existsSync(path.join(repo, ".git", "rebase-merge"))
        ).toBeFalsy();
        expect(
          fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))
        ).toBeFalsy();
        await expect(ops.isClean(project, repo)).resolves.toBeTruthy();
      }
    );

    it("merges a branch into the base with a merge commit or fast-forward only", async () => {
      git(repo, "checkout", "-q", "-b", "feature");
      write(repo, "b.txt", "b\n");
      commitAll(repo, "b");
      git(repo, "checkout", "-q", "main");
      await ops.mergeInto(project, repo, "feature", false);
      expect(
        git(repo, "log", "-1", "--format=%p").trim().split(" ")
      ).toHaveLength(2);
      git(repo, "checkout", "-q", "-b", "ff");
      write(repo, "c.txt", "c\n");
      commitAll(repo, "c");
      git(repo, "checkout", "-q", "main");
      await ops.mergeInto(project, repo, "ff", true);
      expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("c");
    });

    it("aborts a conflicting merge into the base", async () => {
      git(repo, "checkout", "-q", "-b", "feature");
      write(repo, "a.txt", "one\nTWO feature\nthree\n");
      commitAll(repo, "feature two");
      git(repo, "checkout", "-q", "main");
      write(repo, "a.txt", "one\nTWO main\nthree\n");
      commitAll(repo, "main two");
      const before = git(repo, "rev-parse", "HEAD");
      const err = await ops
        .mergeInto(project, repo, "feature", false)
        .catch((error: unknown) => error);
      expect(err).toBeInstanceOf(CommandError);
      expect((err as Error).message).toMatch(/conflicts in a\.txt/u);
      expect(git(repo, "rev-parse", "HEAD")).toBe(before);
      expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBeFalsy();
    });

    it("deletes a merged branch and refuses an unmerged one", async () => {
      git(repo, "branch", "merged");
      await ops.deleteBranch(project, repo, "merged");
      expect(git(repo, "branch", "--list", "merged").trim()).toBe("");
      git(repo, "checkout", "-q", "-b", "open");
      write(repo, "z.txt", "z\n");
      commitAll(repo, "z");
      git(repo, "checkout", "-q", "main");
      await expect(
        ops.deleteBranch(project, repo, "open")
      ).rejects.toBeInstanceOf(CommandError);
    });

    it.each(["rebase", "merge"] as const)(
      "never leaves a %s half-done when it fails without conflicts",
      async (strategy) => {
        git(repo, "checkout", "-q", "-b", "feature");
        write(repo, "b.txt", "b\n");
        commitAll(repo, "b");
        const before = git(repo, "rev-parse", "HEAD");
        git(repo, "checkout", "-q", "main");
        write(repo, "c.txt", "c\n");
        commitAll(repo, "c");
        git(repo, "checkout", "-q", "feature");
        // Signing is required but impossible, as in a container that copied a gpgsign host config without the key.
        git(repo, "config", "commit.gpgsign", "true");
        git(repo, "config", "gpg.program", "false");
        await expect(
          ops.update(project, repo, "main", strategy)
        ).rejects.toBeInstanceOf(CommandError);
        expect(git(repo, "rev-parse", "HEAD")).toBe(before);
        expect(
          fs.existsSync(path.join(repo, ".git", "rebase-merge"))
        ).toBeFalsy();
        expect(
          fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))
        ).toBeFalsy();
      }
    );

    it("never leaves a merge into the base half-done when it fails without conflicts", async () => {
      git(repo, "checkout", "-q", "-b", "feature");
      write(repo, "b.txt", "b\n");
      commitAll(repo, "b");
      git(repo, "checkout", "-q", "main");
      const before = git(repo, "rev-parse", "HEAD");
      git(repo, "config", "commit.gpgsign", "true");
      git(repo, "config", "gpg.program", "false");
      await expect(
        ops.mergeInto(project, repo, "feature", false)
      ).rejects.toBeInstanceOf(CommandError);
      expect(git(repo, "rev-parse", "HEAD")).toBe(before);
      expect(fs.existsSync(path.join(repo, ".git", "MERGE_HEAD"))).toBeFalsy();
    });
  });

  describe("localBranches", () => {
    it("lists local branch names, slashes included", async () => {
      git(repo, "branch", "feature/x");
      const localBranches = await ops.localBranches(project, repo);
      expect(localBranches.toSorted()).toStrictEqual(["feature/x", "main"]);
    });
  });

  describe("deleteBranch", () => {
    it("deletes an unmerged branch only when forced", async () => {
      git(repo, "checkout", "-q", "-b", "side");
      write(repo, "s.txt", "s\n");
      commitAll(repo, "side");
      git(repo, "checkout", "-q", "main");
      await expect(
        ops.deleteBranch(project, repo, "side")
      ).rejects.toBeInstanceOf(CommandError);
      await ops.deleteBranch(project, repo, "side", true);
      expect(git(repo, "branch", "--list", "side").trim()).toBe("");
    });
  });

  describe("fileBytes", () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0,
    ]);

    it("reads a file's bytes at a commit and in the working copy", async () => {
      fs.writeFileSync(path.join(repo, "logo.png"), png);
      commitAll(repo, "logo");
      fs.writeFileSync(path.join(repo, "logo.png"), Buffer.from([1, 2, 255]));
      await expect(
        ops.fileBytes(project, repo, "logo.png", { maxBytes: 100, rev: "HEAD" })
      ).resolves.toStrictEqual(png);
      await expect(
        ops.fileBytes(project, repo, "logo.png", { maxBytes: 100 })
      ).resolves.toStrictEqual(Buffer.from([1, 2, 255]));
    });

    it("is undefined for a file missing there, a folder or a symlink", async () => {
      fs.mkdirSync(path.join(repo, "dir"));
      fs.symlinkSync(path.join(repo, "a.txt"), path.join(repo, "link.png"));
      for (const [file, rev] of [
        ["new.png", "HEAD"],
        ["new.png", undefined],
        ["dir", undefined],
        ["link.png", undefined],
      ] as const) {
        await expect(
          ops.fileBytes(project, repo, file, {
            maxBytes: 100,
            ...(rev ? { rev } : {}),
          })
        ).resolves.toBeUndefined();
      }
    });

    it("refuses a file larger than the limit", async () => {
      fs.writeFileSync(path.join(repo, "logo.png"), png);
      commitAll(repo, "logo");
      for (const rev of ["HEAD", undefined]) {
        await expect(
          ops.fileBytes(project, repo, "logo.png", {
            maxBytes: 4,
            ...(rev ? { rev } : {}),
          })
        ).rejects.toThrow("larger than 4 bytes");
      }
    });

    it("finds the merge-base with a base", async () => {
      const main = git(repo, "rev-parse", "HEAD").trim();
      git(repo, "checkout", "-q", "-b", "feature");
      write(repo, "b.txt", "b\n");
      commitAll(repo, "b");
      await expect(ops.mergeBase(project, repo, "main")).resolves.toBe(main);
      await expect(
        ops.mergeBase(project, repo, "missing")
      ).resolves.toBeUndefined();
    });
  });

  describe("headObjects", () => {
    it("returns the object id of each path at HEAD, undefined where it is missing", async () => {
      const exec = vi.fn<
        (
          p: Project,
          cmd: string[],
          o?: { timeoutMs?: number }
        ) => Promise<RunResult>
      >((_p: Project, _cmd: string[], _o?: { timeoutMs?: number }) =>
        Promise.resolve({
          exitCode: 0,
          stdout: "aaa\n-\nbbb\n",
          stderr: "",
          timedOut: false,
        })
      );

      const ops = new GitOps({ containers: { exec } });
      await expect(
        ops.headObjects(project, "/w/x", [
          ".devcontainer",
          ".devcontainer.json",
          "package-lock.json",
        ])
      ).resolves.toStrictEqual(["aaa", undefined, "bbb"]);
      expect(exec.mock.calls[0][1].slice(0, 2)).toStrictEqual(["sh", "-c"]);
      expect(exec.mock.calls[0][1].slice(3)).toStrictEqual([
        "sh",
        "/w/x",
        ".devcontainer",
        ".devcontainer.json",
        "package-lock.json",
      ]);
    });
  });

  describe(parseBranchRefs, () => {
    it("reads names, upstreams and gone tracking", () => {
      const out =
        "main\trefs/remotes/origin/main\t\nfeat\trefs/remotes/origin/feat\t[gone]\nlocal\t\t\nahead\trefs/remotes/origin/ahead\t[ahead 2]\n";
      expect(parseBranchRefs(out)).toStrictEqual([
        { name: "main", upstream: "refs/remotes/origin/main", gone: false },
        { name: "feat", upstream: "refs/remotes/origin/feat", gone: true },
        { name: "local", gone: false },
        { name: "ahead", upstream: "refs/remotes/origin/ahead", gone: false },
      ]);
    });
  });

  describe("GitOps cleanup queries", () => {
    const p: Project = {
      id: "demo",
      name: "demo",
      path: "/src/demo",
      devcontainerPath: "/x",
    };
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const ops = (handler: (cmd: string[]) => Partial<RunResult>) => {
      const calls: {
        cmd: string[];
        opts?: { env?: Record<string, string>; timeoutMs?: number };
      }[] = [];
      const containers = {
        exec: (
          _t: unknown,
          cmd: string[],
          opts?: { env?: Record<string, string>; timeoutMs?: number }
        ): Promise<RunResult> => {
          calls.push({ cmd, opts });
          return Promise.resolve({
            exitCode: 0,
            stdout: "",
            stderr: "",
            timedOut: false,
            ...handler(cmd),
          });
        },
      };
      return { git: new GitOps({ containers }), calls };
    };

    it("fetches with prune, no prompts and a 60 s timeout", async () => {
      const { git, calls } = ops(() => ({}));
      await git.fetchPrune(p, "/w", "origin");
      expect(calls[0].cmd).toStrictEqual([
        "git",
        "-C",
        "/w",
        "fetch",
        "--prune",
        "--quiet",
        "origin",
      ]);
      expect(calls[0].opts).toStrictEqual({
        env: { GIT_TERMINAL_PROMPT: "0" },
        timeoutMs: 60_000,
      });
    });

    it("reports a failed or timed-out fetch", async () => {
      await expect(
        ops(() => ({
          exitCode: 128,
          stderr: "fatal: could not read from remote",
        })).git.fetchPrune(p, "/w", "origin")
      ).rejects.toThrow(/could not read from remote/u);
      await expect(
        ops(() => ({ exitCode: 143, timedOut: true })).git.fetchPrune(
          p,
          "/w",
          "origin"
        )
      ).rejects.toThrow(/timed out/u);
    });

    it("strips the remote from its HEAD branch", async () => {
      await expect(
        ops(() => ({ stdout: "origin/main\n" })).git.remoteHead(
          p,
          "/w",
          "origin"
        )
      ).resolves.toBe("main");
      await expect(
        ops(() => ({ exitCode: 1 })).git.remoteHead(p, "/w", "origin")
      ).resolves.toBeUndefined();
    });

    it("answers ancestry, and throws when git can't", async () => {
      const { git, calls } = ops((cmd) => ({
        exitCode: cmd.at(-1) === "main" ? 0 : cmd.at(-1) === "dev" ? 1 : 128,
        stderr: "fatal: Not a valid object name",
      }));
      await expect(
        git.isAncestor(p, "/w", "feat", "main")
      ).resolves.toBeTruthy();
      expect(calls[0].cmd).toStrictEqual([
        "git",
        "-C",
        "/w",
        "merge-base",
        "--is-ancestor",
        "refs/heads/feat",
        "main",
      ]);
      await expect(git.isAncestor(p, "/w", "feat", "dev")).resolves.toBeFalsy();
      await expect(git.isAncestor(p, "/w", "feat", "gone")).rejects.toThrow(
        /Not a valid object name/u
      );
    });

    it("lists remotes and branch refs", async () => {
      const { git, calls } = ops((cmd) => ({
        stdout: cmd[3] === "remote" ? "origin\nfork\n" : "feat\t\t\n",
      }));
      await expect(git.remotes(p, "/w")).resolves.toStrictEqual([
        "origin",
        "fork",
      ]);
      await expect(git.branchRefs(p, "/w")).resolves.toStrictEqual([
        { name: "feat", gone: false },
      ]);
      expect(calls[1].cmd).toStrictEqual([
        "git",
        "-C",
        "/w",
        "for-each-ref",
        "--format=%(refname:short)%09%(upstream)%09%(upstream:track)",
        "refs/heads",
      ]);
    });
  });

  describe(hostHeadObjects, () => {
    it("runs git on the host in the folder, one object per path", async () => {
      const fake = fakeRunner(() => ({ stdout: "abc123\n-\n" }));
      await expect(
        hostHeadObjects(fake.run, "/home/tim/w/fix", [
          ".devcontainer",
          "package-lock.json",
        ])
      ).resolves.toStrictEqual(["abc123", undefined]);
      expect(fake.calls[0].cmd).toBe("sh");
      expect(fake.calls[0].args.slice(2)).toStrictEqual([
        "sh",
        "/home/tim/w/fix",
        ".devcontainer",
        "package-lock.json",
      ]);
    });

    it("throws when git fails", async () => {
      await expect(
        hostHeadObjects(
          fakeRunner(() => ({
            exitCode: 128,
            stderr: "fatal: not a git repository\n",
          })).run,
          "/x",
          ["a"]
        )
      ).rejects.toThrow(/git rev-parse failed/u);
    });
  });

  describe("PR worktree source", () => {
    it("fetches the PR ref from a matching remote and verifies the exact commit", async () => {
      const sha = "a".repeat(40);
      const exec = vi.fn(async (_p: unknown, cmd: string[]) => {
        const args = cmd.slice(3);
        const stdout =
          args[0] === "remote"
            ? args[1] === "get-url"
              ? "git@forge.example:team/demo.git\n"
              : "origin\n"
            : args[0] === "rev-parse"
              ? sha
              : "";
        return { exitCode: 0, stdout, stderr: "", timedOut: false };
      });
      const gitOps = new GitOps({ containers: { exec } });
      await expect(
        gitOps.fetchPull(
          project,
          "/repo",
          "https://forge.example/team/demo/pulls/7",
          7,
          sha
        )
      ).resolves.toBe(sha);
      expect(
        exec.mock.calls.find(([, cmd]) => cmd.includes("fetch"))?.[1]
      ).toStrictEqual([
        "git",
        "-C",
        "/repo",
        "fetch",
        "--no-tags",
        "--",
        "origin",
        "refs/pull/7/head",
      ]);
      await expect(
        gitOps.fetchPull(
          project,
          "/repo",
          "https://other.example/team/demo/pulls/7",
          7,
          sha
        )
      ).rejects.toThrow("no remote matching");
      await expect(
        gitOps.fetchPull(
          project,
          "/repo",
          "https://forge.example/team/demo/pulls/7",
          7,
          "b".repeat(40)
        )
      ).rejects.toThrow("PR changed");
    });
  });
});
