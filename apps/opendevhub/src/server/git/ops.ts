import type {
  BasePosition,
  BaseSkipReason,
  UpdateResult,
  UpdateStrategy,
} from "../../shared/types";
import { CommandError, gitReason, tailLines } from "../environments/containers";
import type { Containers, ExecTarget } from "../environments/containers";
import type { RunResult, Runner } from "../nodes/exec";
import { parseRemote } from "./forge";
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
const REMOTES = "refs/remotes/";

/** A local branch's upstream: `origin/main`, its full ref, and the remote it lives on. */
export interface BaseUpstream {
  name: string;
  ref: string;
  remote?: string;
}

/** Where the local base stands against its upstream, and what bringing it up to date does (or did). */
export type BaseState = Omit<
  BasePosition,
  "base" | "sinceBranch" | "branchAhead" | "lastFetchAt" | "fetchError"
>;

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

/** Enough of a failed command's output to show what a hook (lint, tests) complained about. */
const FAILURE_LOG_LINES = 60;

const failure = (args: string[], r: RunResult): CommandError => {
  const tail = tailLines(`${r.stderr}\n${r.stdout}`, FAILURE_LOG_LINES);
  return new CommandError(
    `git ${args[0]} failed: ${gitReason(tail) ?? `exit ${r.exitCode}`}`,
    tail
  );
};

const HEAD_OBJECTS =
  'd="$1"; shift; for p in "$@"; do git -C "$d" rev-parse --verify --quiet "HEAD:$p" || echo -; done';

const STAGE_SPLIT = "\n@@@odh-split-7f3a9c@@@\n";
const STAGE_DIFFS = `cd "$1" || exit 1
if [ "$2" = 1 ]; then
  git ls-files --others --exclude-standard -z | xargs -0 -r git add -N -- || exit 1
  git diff --no-color --no-ext-diff || exit 1
fi
printf '${STAGE_SPLIT.replaceAll("\n", "\\n")}'
if [ "$3" = 1 ]; then git diff --cached --no-color --no-ext-diff || exit 1; fi`;

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

const lines = (out: string): string[] =>
  out.split("\n").filter((l) => l.trim());

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

  /** Fetches the PR's source branch and checks that it still points at the reviewed commit. */
  async fetchPullBranch(
    p: ExecTarget,
    dir: string,
    url: string,
    number: number,
    commitId: string,
    branch: string,
    headRepository?: string
  ): Promise<{ base?: string; upstream: string }> {
    await this.fetchPull(p, dir, url, number, commitId);
    const expected = new URL(url);
    const repoPath =
      headRepository ??
      decodeURIComponent(expected.pathname)
        .replace(/\/pulls\/\d+$/u, "")
        .replace(/^\//u, "");
    for (const remote of await this.remotes(p, dir)) {
      const info = parseRemote(
        await this.git(p, dir, ["remote", "get-url", remote])
      );
      if (info?.host !== expected.hostname || info.path !== repoPath) {
        continue;
      }
      const upstream = `${remote}/${branch}`;
      const fetched = await this.deps.containers.exec(
        p,
        [
          "git",
          "-C",
          dir,
          "fetch",
          "--no-tags",
          "--",
          remote,
          `+refs/heads/${branch}:refs/remotes/${upstream}`,
        ],
        { env: { GIT_TERMINAL_PROMPT: "0" }, timeoutMs: FETCH_TIMEOUT_MS }
      );
      if (fetched.exitCode !== 0) {
        throw failure(["fetch"], fetched);
      }
      const resolved = await this.git(p, dir, [
        "rev-parse",
        `refs/remotes/${upstream}`,
      ]);
      const head = resolved.trim();
      if (head !== commitId) {
        throw new CommandError(
          "The PR branch changed. Refresh its diff before creating a worktree."
        );
      }
      const local = await this.exec(p, dir, [
        "rev-parse",
        "--verify",
        "-q",
        `refs/heads/${branch}`,
      ]);
      if (local.exitCode === 0 && local.stdout.trim() !== commitId) {
        throw new CommandError(
          `Local branch ${branch} differs from the PR head. Update it before creating a worktree.`
        );
      }
      return { base: local.exitCode === 0 ? undefined : commitId, upstream };
    }
    throw new CommandError(
      `This project has no remote matching the PR source repository ${repoPath}. Add that repository as a remote before creating the worktree.`
    );
  }

  /**
   * The local branch `base`'s upstream: its configured one (`<base>@{u}`), else `<remote>/<base>` when that ref exists,
   * with `origin` as the remote, else the first. Undefined for a base that isn't a local branch, or has neither.
   */
  async baseUpstream(
    p: ExecTarget,
    dir: string,
    base: string
  ): Promise<BaseUpstream | undefined> {
    const local = await this.exec(p, dir, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${base}`,
    ]);
    if (local.exitCode !== 0) {
      return undefined;
    }
    const configured = await this.exec(p, dir, [
      "rev-parse",
      "--symbolic-full-name",
      `${base}@{u}`,
    ]);
    const ref = configured.stdout.trim();
    if (configured.exitCode === 0 && ref.startsWith(REMOTES)) {
      const remote = await this.exec(p, dir, [
        "config",
        "--get",
        `branch.${base}.remote`,
      ]);
      const name = remote.stdout.trim();
      return {
        name: ref.slice(REMOTES.length),
        ref,
        ...(remote.exitCode === 0 && name ? { remote: name } : {}),
      };
    }
    const remotes = await this.remotes(p, dir);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (!remote) {
      return undefined;
    }
    const fallback = `${REMOTES}${remote}/${base}`;
    const found = await this.exec(p, dir, [
      "show-ref",
      "--verify",
      "--quiet",
      fallback,
    ]);
    return found.exitCode === 0
      ? { name: `${remote}/${base}`, ref: fallback, remote }
      : undefined;
  }

  /**
   * Brings the local branch `base` up to its upstream when that is a fast-forward and touches no uncommitted work:
   * `merge --ff-only` in the main checkout at `ws` when it is on `base` and clean, else `fetch .` into the branch
   * (which git refuses unless it fast-forwards). `dryRun` only says what it would do. Never merges, rebases or resets.
   */
  async updateBase(
    p: ExecTarget,
    ws: string,
    base: string,
    opts: { dryRun?: boolean } = {}
  ): Promise<BaseState> {
    const upstream = await this.baseUpstream(p, ws, base);
    if (!upstream) {
      return {
        ahead: 0,
        behind: 0,
        update: { kind: "skip", reason: "no-upstream" },
      };
    }
    const counts = parseAheadBehind(
      await this.git(p, ws, [
        "rev-list",
        "--left-right",
        "--count",
        `${upstream.ref}...refs/heads/${base}`,
      ])
    );
    const state = {
      ahead: counts.ahead,
      behind: counts.behind,
      upstream: upstream.name,
      ...(upstream.remote ? { remote: upstream.remote } : {}),
    };
    const skip = (reason: BaseSkipReason): BaseState => ({
      ...state,
      update: { kind: "skip", reason },
    });
    if (counts.behind === 0) {
      return { ...state, update: { kind: "up-to-date" } };
    }
    if (counts.ahead > 0) {
      return skip("diverged");
    }
    const checkedOut = (await this.currentBranch(p, ws)) === base;
    if (checkedOut && !(await this.isClean(p, ws))) {
      return skip("dirty");
    }
    if (!opts.dryRun) {
      await this.git(
        p,
        ws,
        checkedOut
          ? ["merge", "--ff-only", "--quiet", upstream.ref]
          : ["fetch", "--quiet", ".", `${upstream.ref}:refs/heads/${base}`]
      );
    }
    return { ...state, update: { commits: counts.behind, kind: "ff" } };
  }

  /**
   * The local `branch` next to `ref` (its base's upstream): its commits `ref` lacks, and `ref`'s commits it lacks,
   * which is what the upstream gained since the branch was made.
   */
  async branchVsUpstream(
    p: ExecTarget,
    dir: string,
    branch: string,
    ref: string
  ): Promise<{ ahead: number; behind: number }> {
    return parseAheadBehind(
      await this.git(p, dir, [
        "rev-list",
        "--left-right",
        "--count",
        `${ref}...refs/heads/${branch}`,
      ])
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

  /**
   * Whether the branch never got a commit of its own: its reflog holds only its creation, or (without a reflog) it
   * points at `base`'s commit. A brand-new task branch is an ancestor of its base, yet nothing was merged.
   */
  async neverMoved(
    p: ExecTarget,
    dir: string,
    branch: string,
    base: string
  ): Promise<boolean> {
    const log = await this.exec(p, dir, [
      "reflog",
      "show",
      "-n",
      "2",
      "--format=%H",
      `refs/heads/${branch}`,
      "--",
    ]);
    const entries =
      log.exitCode === 0 ? log.stdout.split("\n").filter((l) => l.trim()) : [];
    if (entries.length > 0) {
      return entries.length === 1;
    }
    const tips = await this.exec(p, dir, [
      "rev-parse",
      `refs/heads/${branch}^{commit}`,
      `${base}^{commit}`,
    ]);
    const [own, of] = tips.stdout.split("\n").map((l) => l.trim());
    return tips.exitCode === 0 && own !== undefined && own === of;
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

  /** `git log` since `since` (exclusive), one `<short sha> <subject>` line per commit, newest first. */
  async commitsSince(
    p: ExecTarget,
    dir: string,
    since: string
  ): Promise<string[]> {
    return lines(
      await this.git(p, dir, ["log", "--format=%h %s", `${since}..HEAD`])
    );
  }

  /** `git diff --stat` from `from` to HEAD: a line per file, then the summary line. */
  async diffStat(p: ExecTarget, dir: string, from: string): Promise<string[]> {
    return lines(await this.git(p, dir, ["diff", "--stat=120", from, "HEAD"]));
  }

  /** `git status --short`: a line per uncommitted change. */
  async statusLines(p: ExecTarget, dir: string): Promise<string[]> {
    return lines(await this.git(p, dir, ["status", "--short"]));
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

  /** No uncommitted change, or none under `paths` when given. */
  async isClean(
    p: ExecTarget,
    dir: string,
    paths: readonly string[] = []
  ): Promise<boolean> {
    const result4 = await this.git(p, dir, [
      "status",
      "--porcelain",
      ...(paths.length > 0 ? ["--", ...paths] : []),
    ]);
    return result4.trim() === "";
  }

  /** Pushed: the branch has an upstream. Whether opendevhub published it is on its branch row. */
  async isPushed(p: ExecTarget, dir: string): Promise<boolean> {
    const r = await this.exec(p, dir, [
      "rev-parse",
      "--abbrev-ref",
      "--symbolic-full-name",
      "@{u}",
    ]);
    return r.exitCode === 0;
  }

  /** Commits on HEAD its upstream lacks (not pushed yet); undefined without an upstream. */
  async unpushed(p: ExecTarget, dir: string): Promise<number | undefined> {
    const r = await this.exec(p, dir, ["rev-list", "--count", "@{u}..HEAD"]);
    const n = Number(r.stdout.trim());
    return r.exitCode === 0 && Number.isFinite(n) ? n : undefined;
  }

  private async requireIdentity(p: ExecTarget, dir: string): Promise<void> {
    for (const key of ["user.name", "user.email"]) {
      const r = await this.exec(p, dir, ["config", key]);
      if (r.exitCode !== 0 || !r.stdout.trim()) {
        throw new CommandError(IDENTITY_HINT);
      }
    }
  }

  /**
   * The raw `git diff` of the working tree against the index (`unstaged`) and of the index against HEAD (`staged`),
   * read in one exec: every call into a container costs a round trip. New files the agent created are registered
   * with intent-to-add first, so the working tree diff lists them as added.
   */
  async diffs(
    p: ExecTarget,
    dir: string,
    want: "unstaged" | "staged" | "both" = "both"
  ): Promise<{ unstaged: string; staged: string }> {
    const args = ["diff", dir, want];
    const r = await this.deps.containers.exec(
      p,
      [
        "sh",
        "-c",
        STAGE_DIFFS,
        "sh",
        dir,
        want === "staged" ? "0" : "1",
        want === "unstaged" ? "0" : "1",
      ],
      { timeoutMs: GIT_TIMEOUT_MS }
    );
    if (r.exitCode !== 0) {
      throw failure(args, r);
    }
    const [unstaged = "", staged = ""] = r.stdout.split(STAGE_SPLIT);
    return { staged, unstaged };
  }

  /**
   * Applies one hunk's patch: to the index (`stage`), out of the index (`unstage`) or backwards onto the working
   * tree (`discard`, which drops the change from the file).
   */
  async applyHunk(
    p: ExecTarget,
    dir: string,
    patch: string,
    action: "stage" | "unstage" | "discard"
  ): Promise<void> {
    const flags = {
      discard: ["-R"],
      stage: ["--cached"],
      unstage: ["--cached", "-R"],
    }[action];
    const args = ["apply", "--whitespace=nowarn", ...flags, "-"];
    const r = await this.deps.containers.exec(p, ["git", "-C", dir, ...args], {
      input: patch,
      timeoutMs: GIT_TIMEOUT_MS,
    });
    if (r.exitCode !== 0) {
      throw failure(args, r);
    }
  }

  /** Stages every change under `paths`, or all of them. */
  async stageAll(
    p: ExecTarget,
    dir: string,
    paths: readonly string[] = []
  ): Promise<void> {
    await this.git(p, dir, [
      "add",
      "-A",
      "--",
      ...(paths.length ? paths : ["."]),
    ]);
  }

  /** Takes every change under `paths`, or all of them, out of the index. */
  async unstageAll(
    p: ExecTarget,
    dir: string,
    paths: readonly string[] = []
  ): Promise<void> {
    await this.git(p, dir, [
      "reset",
      "-q",
      "--",
      ...(paths.length ? paths : ["."]),
    ]);
  }

  /** Commits what is staged. */
  async commitStaged(
    p: ExecTarget,
    dir: string,
    message: string
  ): Promise<void> {
    await this.requireIdentity(p, dir);
    await this.git(p, dir, ["commit", "-q", "-m", message]);
  }

  /** Whether anything is staged. */
  async hasStaged(p: ExecTarget, dir: string): Promise<boolean> {
    const r = await this.exec(p, dir, ["diff", "--cached", "--quiet"]);
    return r.exitCode === 1;
  }

  /** Commits every change, or only those under `paths` when given. */
  async commit(
    p: ExecTarget,
    dir: string,
    message: string,
    paths: readonly string[] = []
  ): Promise<void> {
    await this.requireIdentity(p, dir);
    const only = paths.length > 0 ? ["--", ...paths] : [];
    await this.git(p, dir, ["add", "-A", ...only]);
    await this.git(p, dir, ["commit", "-q", "-m", message, ...only]);
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

  /**
   * Creates `branch` at HEAD and switches to it; uncommitted changes, staged or not, come along. Records `base`
   * as what the branch was made from, for review.
   */
  async createBranch(
    p: ExecTarget,
    dir: string,
    branch: string,
    base?: string
  ): Promise<void> {
    await this.git(p, dir, ["switch", "-q", "-c", branch]);
    if (base) {
      await this.git(p, dir, ["config", baseKey(branch), base]);
    }
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
