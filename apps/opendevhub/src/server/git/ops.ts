import type { UpdateResult, UpdateStrategy } from "../../shared/types";
import { CommandError, tailLines } from "../environments/containers";
import type { Containers, ExecTarget } from "../environments/containers";
import type { RunResult, Runner } from "../nodes/exec";
import { baseKey } from "./worktrees";

export type { UpdateResult, UpdateStrategy };

const GIT_TIMEOUT_MS = 120_000;

export const IDENTITY_HINT =
  "git has no user.name/user.email in the container. opendevhub copies them from this machine when the container starts: set them with `git config --global user.name …` and `git config --global user.email …` here (or in the devcontainer), then restart the project.";

/** `git rev-list --left-right --count base...HEAD` prints "<behind>\t<ahead>". */
export const parseAheadBehind = (
  out: string
): {
  ahead: number;
  behind: number;
} => {
  const [behind, ahead] = out.trim().split(/\s+/u).map(Number);
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  };
};

const FETCH_TIMEOUT_MS = 60_000;
const REF_FORMAT = "%(refname:short)%09%(upstream)%09%(upstream:track)";

export interface BranchRef {
  name: string;
  /** Full ref of its upstream, when it has one. */
  upstream?: string;
  /** The upstream was deleted on the remote (pruned by the last fetch). */
  gone: boolean;
}

/** `git for-each-ref` lines of name, upstream and track, separated by tabs (ref names can't hold tabs). */
export const parseBranchRefs = (out: string): BranchRef[] =>
  out
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const [name, upstream, track] = line.split("\t");
      return {
        name,
        ...(upstream ? { upstream } : {}),
        gone: track?.trim() === "[gone]",
      };
    });

const failure = (args: string[], r: RunResult): CommandError => {
  const tail = tailLines(`${r.stderr}\n${r.stdout}`, 5);
  return new CommandError(
    `git ${args[0]} failed: ${tail.at(-1) ?? `exit ${r.exitCode}`}`,
    tail
  );
};

const HEAD_OBJECTS =
  'd="$1"; shift; for p in "$@"; do git -C "$d" rev-parse --verify --quiet "HEAD:$p" || echo -; done';

const MISSING_EXIT = 3;
const TOO_LARGE_EXIT = 4;

/** Prints a file as base64: the blob at "$2" (a commit), or the working copy's file (not a symlink) when "$2" is empty. */
const READ_FILE = `d="$1"; rev="$2"; p="$3"; max="$4"
if [ -n "$rev" ]; then
  [ "$(git -C "$d" cat-file -t "$rev:$p" 2>/dev/null)" = blob ] || exit ${MISSING_EXIT}
  [ "$(git -C "$d" cat-file -s "$rev:$p")" -le "$max" ] || exit ${TOO_LARGE_EXIT}
  git -C "$d" cat-file blob "$rev:$p" | base64
else
  [ -f "$d/$p" ] && [ ! -L "$d/$p" ] || exit ${MISSING_EXIT}
  [ "$(wc -c < "$d/$p")" -le "$max" ] || exit ${TOO_LARGE_EXIT}
  base64 < "$d/$p"
fi`;

const parseHeadObjects = (
  stdout: string,
  paths: string[]
): (string | undefined)[] => {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return paths.map((_, i) =>
    lines[i] && lines[i] !== "-" ? lines[i] : undefined
  );
};

/** Like GitOps.headObjects, but with the git of the machine `run` reaches (a node), not a container's. */
export const hostHeadObjects = async (
  run: Runner,
  dir: string,
  paths: string[]
): Promise<(string | undefined)[]> => {
  const r = await run("sh", ["-c", HEAD_OBJECTS, "sh", dir, ...paths], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (r.exitCode !== 0) {
    throw failure(["rev-parse"], r);
  }
  return parseHeadObjects(r.stdout, paths);
};

/** Local git work for review, run in the project's container on one checkout. Callers validate refs and paths. */
export class GitOps {
  private readonly deps: { containers: Pick<Containers, "exec"> };
  constructor(deps: { containers: Pick<Containers, "exec"> }) {
    this.deps = deps;
  }

  /** The object id of each path at HEAD (a tree for folders, a blob for files); undefined where it doesn't exist. */
  async headObjects(
    p: ExecTarget,
    dir: string,
    paths: string[]
  ): Promise<(string | undefined)[]> {
    const r = await this.deps.containers.exec(
      p,
      ["sh", "-c", HEAD_OBJECTS, "sh", dir, ...paths],
      { timeoutMs: GIT_TIMEOUT_MS }
    );
    if (r.exitCode !== 0) {
      throw failure(["rev-parse"], r);
    }
    return parseHeadObjects(r.stdout, paths);
  }

  private exec(p: ExecTarget, dir: string, args: string[]): Promise<RunResult> {
    return this.deps.containers.exec(p, ["git", "-C", dir, ...args], {
      timeoutMs: GIT_TIMEOUT_MS,
    });
  }

  private async git(
    p: ExecTarget,
    dir: string,
    args: string[]
  ): Promise<string> {
    const r = await this.exec(p, dir, args);
    if (r.exitCode !== 0) {
      throw failure(args, r);
    }
    return r.stdout;
  }

  private async conflicts(p: ExecTarget, dir: string): Promise<string[]> {
    const r = await this.exec(p, dir, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    return r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async currentBranch(p: ExecTarget, dir: string): Promise<string | undefined> {
    const r = await this.exec(p, dir, [
      "symbolic-ref",
      "--short",
      "-q",
      "HEAD",
    ]);
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
  }

  /** The commit checked out; undefined in a repository without commits. */
  async head(p: ExecTarget, dir: string): Promise<string | undefined> {
    const r = await this.exec(p, dir, ["rev-parse", "--verify", "-q", "HEAD"]);
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
  }

  /** Local branch names, e.g. to keep generated task branches free. */
  async localBranches(p: ExecTarget, dir: string): Promise<string[]> {
    const result = await this.git(p, dir, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    return result
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async remotes(p: ExecTarget, dir: string): Promise<string[]> {
    const result2 = await this.git(p, dir, ["remote"]);
    return result2
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Updates remote-tracking refs and drops ones deleted on the remote; never prompts for credentials. */
  async fetchPrune(p: ExecTarget, dir: string, remote: string): Promise<void> {
    const args = ["fetch", "--prune", "--quiet", remote];
    const r = await this.deps.containers.exec(p, ["git", "-C", dir, ...args], {
      env: { GIT_TERMINAL_PROMPT: "0" },
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (r.timedOut) {
      throw new CommandError(`git fetch ${remote} timed out after 60 s`);
    }
    if (r.exitCode !== 0) {
      throw failure(args, r);
    }
  }

  async fetchPull(
    p: ExecTarget,
    dir: string,
    url: string,
    number: number,
    commitId: string
  ): Promise<string> {
    const { parseRemote } = await import("./forge");
    const expected = new URL(url);
    const repoPath = decodeURIComponent(expected.pathname)
      .replace(/\/pulls\/\d+$/u, "")
      .replace(/^\//u, "");
    for (const remote of await this.remotes(p, dir)) {
      const info = parseRemote(
        await this.git(p, dir, ["remote", "get-url", remote])
      );
      if (info?.host !== expected.hostname || info.path !== repoPath) {
        continue;
      }
      const r = await this.deps.containers.exec(
        p,
        [
          "git",
          "-C",
          dir,
          "fetch",
          "--no-tags",
          "--",
          remote,
          `refs/pull/${number}/head`,
        ],
        {
          env: { GIT_TERMINAL_PROMPT: "0" },
          timeoutMs: FETCH_TIMEOUT_MS,
        }
      );
      if (r.exitCode !== 0) {
        throw failure(["fetch"], r);
      }
      const result3 = await this.git(p, dir, ["rev-parse", "FETCH_HEAD"]);
      const sha = result3.trim();
      if (sha !== commitId) {
        throw new CommandError(
          "The PR changed. Refresh its diff before creating a worktree."
        );
      }
      return sha;
    }
    throw new CommandError(
      "This project has no remote matching the Forgejo repository."
    );
  }

  async branchRefs(p: ExecTarget, dir: string): Promise<BranchRef[]> {
    return parseBranchRefs(
      await this.git(p, dir, [
        "for-each-ref",
        `--format=${REF_FORMAT}`,
        "refs/heads",
      ])
    );
  }

  /** The branch the remote's HEAD points at (`origin/main` → `main`), when the clone recorded it. */
  async remoteHead(
    p: ExecTarget,
    dir: string,
    remote: string
  ): Promise<string | undefined> {
    const r = await this.exec(p, dir, [
      "symbolic-ref",
      "--short",
      "-q",
      `refs/remotes/${remote}/HEAD`,
    ]);
    const ref = r.stdout.trim();
    return r.exitCode === 0 && ref.startsWith(`${remote}/`)
      ? ref.slice(remote.length + 1)
      : undefined;
  }

  /** Whether every commit of the local branch is in `base`. Throws when git can't tell (e.g. `base` doesn't exist). */
  async isAncestor(
    p: ExecTarget,
    dir: string,
    branch: string,
    base: string
  ): Promise<boolean> {
    const args = ["merge-base", "--is-ancestor", `refs/heads/${branch}`, base];
    const r = await this.exec(p, dir, args);
    if (r.exitCode === 0) {
      return true;
    }
    if (r.exitCode === 1) {
      return false;
    }
    throw failure(args, r);
  }

  async recordedBase(
    p: ExecTarget,
    dir: string,
    branch: string
  ): Promise<string | undefined> {
    const r = await this.exec(p, dir, ["config", "--get", baseKey(branch)]);
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
  }

  /** The commit `base` and HEAD branched from; undefined when they share no history. */
  async mergeBase(
    p: ExecTarget,
    dir: string,
    base: string
  ): Promise<string | undefined> {
    const r = await this.exec(p, dir, ["merge-base", base, "HEAD"]);
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
  }

  /**
   * A file's bytes at `rev`, or in the working copy without one; undefined where it doesn't exist. Exec output
   * is text, so the bytes travel as base64.
   */
  async fileBytes(
    p: ExecTarget,
    dir: string,
    file: string,
    opts: { rev?: string; maxBytes: number }
  ): Promise<Buffer | undefined> {
    const r = await this.deps.containers.exec(
      p,
      [
        "sh",
        "-c",
        READ_FILE,
        "sh",
        dir,
        opts.rev ?? "",
        file,
        String(opts.maxBytes),
      ],
      { timeoutMs: GIT_TIMEOUT_MS }
    );
    if (r.exitCode === MISSING_EXIT) {
      return undefined;
    }
    if (r.exitCode === TOO_LARGE_EXIT) {
      throw new CommandError(`${file} is larger than ${opts.maxBytes} bytes`);
    }
    if (r.exitCode !== 0) {
      throw failure(["cat-file"], r);
    }
    return Buffer.from(r.stdout, "base64");
  }

  async aheadBehind(
    p: ExecTarget,
    dir: string,
    base: string
  ): Promise<{ ahead: number; behind: number }> {
    return parseAheadBehind(
      await this.git(p, dir, [
        "rev-list",
        "--left-right",
        "--count",
        `${base}...HEAD`,
      ])
    );
  }

  async isClean(p: ExecTarget, dir: string): Promise<boolean> {
    const result4 = await this.git(p, dir, ["status", "--porcelain"]);
    return result4.trim() === "";
  }

  /** Pushed: the branch has an upstream, or publish recorded it. */
  async isPushed(p: ExecTarget, dir: string, branch: string): Promise<boolean> {
    const result5 = await this.exec(p, dir, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    if (result5.exitCode === 0) {
      return true;
    }
    const result6 = await this.exec(p, dir, [
      "config",
      "--get",
      `branch.${branch}.opendevhubPublished`,
    ]);
    return result6.exitCode === 0;
  }

  private async requireIdentity(p: ExecTarget, dir: string): Promise<void> {
    for (const key of ["user.name", "user.email"]) {
      const r = await this.exec(p, dir, ["config", key]);
      if (r.exitCode !== 0 || !r.stdout.trim()) {
        throw new CommandError(IDENTITY_HINT);
      }
    }
  }

  async commit(p: ExecTarget, dir: string, message: string): Promise<void> {
    await this.requireIdentity(p, dir);
    await this.git(p, dir, ["add", "-A"]);
    await this.git(p, dir, ["commit", "-q", "-m", message]);
  }

  /**
   * Brings `base` into the branch. Any failure (a conflict, a hook, signing, a lock) is aborted, so the checkout
   * is never left mid-way; conflicts are reported, anything else is thrown.
   */
  async update(
    p: ExecTarget,
    dir: string,
    base: string,
    strategy: UpdateStrategy
  ): Promise<UpdateResult> {
    await this.requireIdentity(p, dir);
    const args =
      strategy === "rebase" ? ["rebase", base] : ["merge", "--no-edit", base];
    const r = await this.exec(p, dir, args);
    if (r.exitCode === 0) {
      return { strategy };
    }
    const conflicts = await this.conflicts(p, dir);
    await this.abort(p, dir, strategy);
    if (conflicts.length === 0) {
      throw failure(args, r);
    }
    return { conflicts, strategy };
  }

  /**
   * Undoes a rebase or merge that stopped part-way. When none is in progress git refuses with "no rebase/merge
   * to abort" and nothing changes; otherwise the abort itself must succeed.
   */
  private async abort(
    p: ExecTarget,
    dir: string,
    op: UpdateStrategy
  ): Promise<void> {
    const r = await this.exec(p, dir, [op, "--abort"]);
    if (
      r.exitCode === 0 ||
      /no rebase in progress|no merge to abort|MERGE_HEAD missing/iu.test(
        r.stderr
      )
    ) {
      return;
    }
    throw failure([op, "--abort"], r);
  }

  /** Merges `branch` into the checkout at `workspace`, which is on the base. Any failure is aborted. */
  async mergeInto(
    p: ExecTarget,
    workspace: string,
    branch: string,
    ffOnly: boolean
  ): Promise<void> {
    if (!ffOnly) {
      await this.requireIdentity(p, workspace);
    }
    const args = [
      "merge",
      ffOnly ? "--ff-only" : "--no-ff",
      "--no-edit",
      branch,
    ];
    const r = await this.exec(p, workspace, args);
    if (r.exitCode === 0) {
      return;
    }
    const conflicts = await this.conflicts(p, workspace);
    await this.abort(p, workspace, "merge");
    if (conflicts.length === 0) {
      throw failure(args, r);
    }
    throw new CommandError(
      `merging ${branch} conflicts in ${conflicts.join(", ")}; nothing was merged. Update the branch from its base first.`,
      conflicts
    );
  }

  /** `-d` refuses a branch that isn't merged; `force` (-D) is for branches the user chose to discard. */
  async deleteBranch(
    p: ExecTarget,
    workspace: string,
    branch: string,
    force = false
  ): Promise<void> {
    await this.git(p, workspace, ["branch", force ? "-D" : "-d", branch]);
  }
}
