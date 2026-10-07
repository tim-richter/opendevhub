import path from "node:path";

import type { EnvWorktree, NodeId, Project } from "../shared/types";
import { CommandError, tailLines } from "./containers";
import type { RunResult, Runner } from "./exec";
import type { Host } from "./host";
import { shellQuote } from "./ssh";
import type { SshTarget } from "./ssh";
import { InvalidRequestError, worktreeDirName } from "./worktrees";

const GIT_TIMEOUT_MS = 120_000;

const ENSURE =
  'set -e; mkdir -p "$1"; cd "$1"; if [ ! -d .git ]; then git init -q; git config receive.denyCurrentBranch ignore; fi';

export interface NodeRepoLayout {
  /** The repository on the node, never checked out. */
  repo: string;
  gitDir: string;
  /** Where its worktrees go on the node. */
  worktrees: string;
  /** `ssh://<dest><repo>`, for the hub's git. */
  url: string;
  /** The project's workspace folder in containers; remote worktrees sit at `<workspaceFolder>.worktrees/<dir>`. */
  workspaceFolder: string;
}

export interface NodeRepoPort {
  layout: (project: Project, workspaceFolder: string) => NodeRepoLayout;
  ensure: (layout: NodeRepoLayout) => Promise<void>;
  branches: (layout: NodeRepoLayout) => Promise<string[]>;
  pushBase: (
    project: Project,
    layout: NodeRepoLayout,
    base: string
  ) => Promise<void>;
  addWorktree: (
    layout: NodeRepoLayout,
    branch: string,
    base: string
  ) => Promise<EnvWorktree>;
  removeWorktree: (
    layout: NodeRepoLayout,
    worktree: EnvWorktree
  ) => Promise<void>;
  bringHome: (
    project: Project,
    layout: NodeRepoLayout,
    branch: string
  ) => Promise<void>;
}

const lastLine = (r: RunResult): string =>
  tailLines(`${r.stderr}\n${r.stdout}`, 1)[0] ?? `exit ${r.exitCode}`;

/**
 * The project's repository on a node: created on first use, fed by pushes from this machine, with task
 * worktrees next to it. The hub's git reaches it through the node's ControlMaster.
 */
export class NodeRepo implements NodeRepoPort {
  constructor(
    private readonly deps: {
      node: NodeId;
      host: Pick<Host, "run" | "home">;
      target: SshTarget;
      local: Runner;
    }
  ) {}

  /** Named after the workspace folder, so links git writes relative to the node's layout resolve in containers too. */
  layout(project: Project, workspaceFolder: string): NodeRepoLayout {
    const name = path.posix.basename(workspaceFolder);
    const parent = path.posix.join(
      this.deps.host.home,
      ".opendevhub",
      "repos",
      project.id
    );
    const repo = path.posix.join(parent, name);
    return {
      gitDir: path.posix.join(repo, ".git"),
      repo,
      url: `ssh://${this.deps.target.dest}${repo}`,
      workspaceFolder,
      worktrees: path.posix.join(parent, `${name}.worktrees`),
    };
  }

  async ensure(layout: NodeRepoLayout): Promise<void> {
    const r = await this.deps.host.run(
      "sh",
      ["-c", ENSURE, "sh", layout.repo],
      { timeoutMs: GIT_TIMEOUT_MS }
    );
    if (r.exitCode !== 0) {
      throw new CommandError(
        `preparing ${layout.repo} on ${this.deps.node} failed: ${lastLine(r)}`,
        tailLines(r.stderr)
      );
    }
  }

  async branches(layout: NodeRepoLayout): Promise<string[]> {
    const r = await this.git(layout, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    if (r.exitCode !== 0) {
      return [];
    }
    return r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async pushBase(
    project: Project,
    layout: NodeRepoLayout,
    base: string
  ): Promise<void> {
    const r = await this.hub(project, [
      "push",
      "--no-verify",
      "--quiet",
      layout.url,
      `+${base}:refs/heads/${base}`,
    ]);
    if (r.exitCode !== 0) {
      throw new CommandError(
        `pushing ${base} to ${this.deps.node} failed: ${lastLine(r)}`,
        tailLines(r.stderr)
      );
    }
  }

  async addWorktree(
    layout: NodeRepoLayout,
    branch: string,
    base: string
  ): Promise<EnvWorktree> {
    const dir = worktreeDirName(branch);
    const hostPath = path.posix.join(layout.worktrees, dir);
    await this.must(
      layout,
      [
        "worktree",
        "add",
        "--relative-paths",
        "-b",
        branch,
        "--",
        hostPath,
        base,
      ],
      `creating worktree ${branch}`
    );
    await this.must(
      layout,
      ["config", `branch.${branch}.opendevhubBase`, base],
      `recording the base of ${branch}`
    );
    return {
      branch,
      hostPath,
      path: path.posix.join(`${layout.workspaceFolder}.worktrees`, dir),
    };
  }

  async removeWorktree(
    layout: NodeRepoLayout,
    worktree: EnvWorktree
  ): Promise<void> {
    const r = await this.git(layout, [
      "worktree",
      "remove",
      "--force",
      "--",
      worktree.hostPath,
    ]);
    if (r.exitCode !== 0) {
      if (!/is not a working tree/u.test(r.stderr)) {
        throw new CommandError(
          `removing worktree ${worktree.branch} on ${this.deps.node} failed: ${lastLine(r)}`,
          tailLines(r.stderr)
        );
      }
      await this.git(layout, ["worktree", "prune"]);
    }
    await this.must(
      layout,
      ["branch", "-D", worktree.branch],
      `deleting branch ${worktree.branch}`
    );
  }

  /**
   * Fetches the node's branch into this machine's repository: a new branch, or a fast-forward of the local one.
   * Never moves a local branch that diverged or that the main checkout has checked out.
   */
  async bringHome(
    project: Project,
    layout: NodeRepoLayout,
    branch: string
  ): Promise<void> {
    const incoming = `refs/odh/incoming/${branch}`;
    const local = `refs/heads/${branch}`;
    const fetched = await this.hub(project, [
      "fetch",
      "--no-tags",
      "--quiet",
      layout.url,
      `+${local}:${incoming}`,
    ]);
    if (fetched.exitCode !== 0) {
      throw new CommandError(
        `fetching ${branch} from ${this.deps.node} failed: ${lastLine(fetched)}`,
        tailLines(fetched.stderr)
      );
    }
    try {
      const result = await this.hub(project, [
        "rev-parse",
        "--verify",
        "-q",
        local,
      ]);
      const exists = result.exitCode === 0;
      if (exists) {
        const head = await this.hub(project, [
          "symbolic-ref",
          "--short",
          "-q",
          "HEAD",
        ]);
        if (head.stdout.trim() === branch) {
          throw new InvalidRequestError(
            `${branch} is checked out in the main checkout; switch it to another branch first`
          );
        }
        const ancestor = await this.hub(project, [
          "merge-base",
          "--is-ancestor",
          local,
          incoming,
        ]);
        if (ancestor.exitCode === 1) {
          throw new InvalidRequestError(
            `local branch ${branch} has diverged from the one on ${this.deps.node}`
          );
        }
        if (ancestor.exitCode !== 0) {
          throw new CommandError(
            `comparing ${branch} failed: ${lastLine(ancestor)}`,
            tailLines(ancestor.stderr)
          );
        }
      }
      const moved = await this.hub(project, ["update-ref", local, incoming]);
      if (moved.exitCode !== 0) {
        throw new CommandError(
          `updating ${branch} failed: ${lastLine(moved)}`,
          tailLines(moved.stderr)
        );
      }
    } finally {
      await this.hub(project, ["update-ref", "-d", incoming]);
    }
  }

  private git(layout: NodeRepoLayout, args: string[]): Promise<RunResult> {
    return this.deps.host.run("git", ["-C", layout.repo, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
  }

  private async must(
    layout: NodeRepoLayout,
    args: string[],
    what: string
  ): Promise<void> {
    const r = await this.git(layout, args);
    if (r.exitCode !== 0) {
      throw new CommandError(
        `${what} on ${this.deps.node} failed: ${lastLine(r)}`,
        tailLines(r.stderr)
      );
    }
  }

  /** git in the project's folder on this machine, reaching the node through its ControlMaster. */
  private hub(project: Project, args: string[]): Promise<RunResult> {
    return this.deps.local("git", ["-C", project.path, ...args], {
      detached: true,
      env: {
        GIT_SSH_COMMAND: `ssh -S ${shellQuote(this.deps.target.control)} -o BatchMode=yes`,
        GIT_TERMINAL_PROMPT: "0",
      },
      timeoutMs: GIT_TIMEOUT_MS,
    });
  }
}
