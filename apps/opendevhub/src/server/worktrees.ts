import path from "node:path";

import type { Project, Worktree, WorktreeRoot } from "../shared/types";
import { CommandError, tailLines } from "./containers";
import type { Containers } from "./containers";
import type { Runner } from "./exec";

export const WORKTREES_SUFFIX = ".worktrees";
/** `git worktree add --relative-paths` (and `worktree.useRelativePaths`) landed in git 2.48. */
const RELATIVE_PATHS_SINCE: [number, number] = [2, 48];
const GIT_TIMEOUT_MS = 120_000;

export class InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRequestError";
  }
}

/**
 * The worktrees folder sits next to the checkout on both sides (`~/code/demo.worktrees` on the host,
 * `/workspaces/demo.worktrees` in the container), so a relative gitdir link resolves on both.
 */
export const worktreeRoot = (
  projectPath: string,
  workspaceFolder: string,
  mounted: boolean
): WorktreeRoot => ({
  container:
    path.posix.normalize(workspaceFolder).replace(/\/$/u, "") +
    WORKTREES_SUFFIX,
  host: projectPath + WORKTREES_SUFFIX,
  mounted,
});

export const mountArg = (root: WorktreeRoot): string =>
  `type=bind,source=${root.host},target=${root.container}`;

export const parseGitVersion = (
  output: string
): [number, number] | undefined => {
  const m = output.match(/git version (?<g1>\d+)\.(?<g2>\d+)/u);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
};

export const supportsRelativePaths = (
  version: [number, number] | undefined
): boolean => {
  if (!version) {
    return false;
  }
  const [major, minor] = version;
  return (
    major > RELATIVE_PATHS_SINCE[0] ||
    (major === RELATIVE_PATHS_SINCE[0] && minor >= RELATIVE_PATHS_SINCE[1])
  );
};

/** Branch names users may pick: a safe subset of git's rules (no spaces, `..`, leading `-`, `.lock`…). */
export const validateBranch = (name: string): string => {
  const branch = name.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(branch) ||
    branch.length > 100 ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch
      .split("/")
      .some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new InvalidRequestError(
      `invalid branch name "${name}": use letters, digits, ".", "_", "-" and "/" (not leading, trailing or doubled)`
    );
  }
  return branch;
};

/** The folder a branch's worktree gets under the worktrees root: `feature/login` → `feature-login`. */
export const worktreeDirName = (branch: string): string =>
  branch.replaceAll("/", "-");

/** Where opendevhub remembers what a branch was made from, for review: `branch.<b>.opendevhubBase`. */
export const baseKey = (branch: string): string =>
  `branch.${branch}.opendevhubBase`;

/** Linked worktrees from `git worktree list --porcelain` (the main checkout, bare and prunable entries are dropped). */
export const parseWorktreeList = (
  porcelain: string,
  root: WorktreeRoot | undefined
): Worktree[] => {
  const blocks = porcelain.split(/\n\s*\n/u).filter((b) => b.trim());
  const out: Worktree[] = [];
  for (const [i, block] of blocks.entries()) {
    let wt: Worktree | undefined;
    let skip = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        wt = { path: line.slice("worktree ".length) };
      } else if (line.startsWith("HEAD ") && wt) {
        wt.head = line.slice(5);
      } else if (line.startsWith("branch ") && wt) {
        wt.branch = line.slice(7).replace(/^refs\/heads\//u, "");
      }
      // Prunable worktrees no longer exist at their recorded path (e.g. one created on the host).
      else if (
        line === "bare" ||
        line === "prunable" ||
        line.startsWith("prunable ")
      ) {
        skip = true;
      }
    }
    if (!wt || skip || i === 0) {
      continue;
    }
    if (root?.mounted) {
      const rel = path.posix.relative(root.container, wt.path);
      if (rel && !rel.startsWith("..") && !path.posix.isAbsolute(rel)) {
        wt.hostPath = path.join(root.host, rel);
      }
    }
    out.push(wt);
  }
  return out;
};

export interface AddWorktreeArgs {
  workspaceFolder: string;
  root: WorktreeRoot;
  branch: string;
  base?: string;
  onLine: (line: string) => void;
}

/** Runs git inside the project's container; the host's git version decides whether links may be relative. */
export class Worktrees {
  private hostVersion?: Promise<[number, number] | undefined>;

  private readonly deps: {
    containers: Pick<Containers, "exec">;
    run: Runner;
    /** false forces absolute links, for repos also opened by libgit2-based tools that reject relative ones. */
    relativeLinks?: boolean;
  };
  constructor(deps: {
    containers: Pick<Containers, "exec">;
    run: Runner;
    /** false forces absolute links, for repos also opened by libgit2-based tools that reject relative ones. */
    relativeLinks?: boolean;
  }) {
    this.deps = deps;
  }

  async list(
    project: Project,
    workspaceFolder: string,
    root: WorktreeRoot | undefined
  ): Promise<Worktree[]> {
    const r = await this.git(project, workspaceFolder, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    return parseWorktreeList(r.stdout, root);
  }

  async add(project: Project, args: AddWorktreeArgs): Promise<Worktree> {
    const { workspaceFolder: ws, root, branch, base, onLine } = args;
    if (
      base !== undefined &&
      (base.startsWith("-") || /\s/u.test(base) || base === "")
    ) {
      throw new InvalidRequestError(`invalid base "${base}"`);
    }
    const result = await this.git(project, ws, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const top = result.stdout.trim();
    if (path.posix.normalize(top) !== path.posix.normalize(ws)) {
      throw new InvalidRequestError(
        `worktrees need the workspace folder to be the git root (git root is ${top})`
      );
    }
    const target = path.posix.join(root.container, worktreeDirName(branch));
    const relative = await this.relativeLinks(project, ws, root, onLine);
    const result2 = await this.deps.containers.exec(project, [
      "git",
      "-C",
      ws,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    const exists = result2.exitCode === 0;
    const cmd = ["worktree", "add"];
    if (relative) {
      cmd.push("--relative-paths");
    }
    if (exists) {
      if (base) {
        throw new InvalidRequestError(
          `branch ${branch} already exists; leave the base empty to check it out`
        );
      }
      cmd.push("--", target, branch);
    } else {
      cmd.push("-b", branch, "--", target);
      if (base) {
        cmd.push(base);
      }
    }
    await this.git(project, ws, cmd);
    await this.recordBase(
      project,
      ws,
      branch,
      exists ? undefined : base,
      exists
    ).catch((error: unknown) =>
      onLine(
        `worktree: could not record the base of ${branch}: ${error instanceof Error ? error.message : String(error)}`
      )
    );
    onLine(
      `worktree: added ${target} (${exists ? "existing" : "new"} branch ${branch}${relative ? "" : ", absolute links"})`
    );
    const hostPath = root.mounted
      ? path.join(root.host, worktreeDirName(branch))
      : undefined;
    return { branch, hostPath, path: target };
  }

  async remove(
    project: Project,
    workspaceFolder: string,
    worktreePath: string,
    force: boolean
  ): Promise<void> {
    const cmd = ["worktree", "remove"];
    if (force) {
      cmd.push("--force");
    }
    await this.git(project, workspaceFolder, [...cmd, "--", worktreePath]);
  }

  /**
   * A new branch records the given base, or the workspace's current branch. An existing branch keeps a base
   * it already has. A detached workspace has nothing to record.
   */
  private async recordBase(
    project: Project,
    ws: string,
    branch: string,
    base: string | undefined,
    existing: boolean
  ) {
    const key = baseKey(branch);
    if (existing) {
      const configured = await this.deps.containers.exec(project, [
        "git",
        "-C",
        ws,
        "config",
        "--get",
        key,
      ]);
      if (configured.exitCode === 0) {
        return;
      }
    }
    let from = base;
    if (!from) {
      const head = await this.deps.containers.exec(project, [
        "git",
        "-C",
        ws,
        "symbolic-ref",
        "--short",
        "-q",
        "HEAD",
      ]);
      from = head.exitCode === 0 ? head.stdout.trim() : "";
    }
    if (from) {
      await this.git(project, ws, ["config", key, from]);
    }
  }

  /**
   * Relative links make the worktree usable from both sides, but they set `extensions.relativeWorktrees`,
   * which git < 2.48 on the host refuses to open — for the whole repository. Only use them when both
   * gits understand them and the checkout has the same folder name on both sides.
   */
  private async relativeLinks(
    project: Project,
    ws: string,
    root: WorktreeRoot,
    onLine: (line: string) => void
  ): Promise<boolean> {
    if (!root.mounted) {
      return false;
    }
    if (this.deps.relativeLinks === false) {
      onLine(
        "worktree: using absolute links (OPENDEVHUB_RELATIVE_WORKTREES=0); git commands in it only work inside the container"
      );
      return false;
    }
    const result3 = await this.deps.containers.exec(project, [
      "git",
      "--version",
    ]);
    const container = parseGitVersion(result3.stdout);
    const host = await this.hostGitVersion();
    let reason: string | undefined;
    if (path.posix.basename(ws) !== path.basename(project.path)) {
      reason = `the workspace folder (${ws}) is named differently from ${project.path}`;
    } else if (!supportsRelativePaths(container)) {
      reason = `git in the container is older than 2.48 (${container?.join(".") ?? "unknown"})`;
    } else if (!supportsRelativePaths(host)) {
      reason = `git on this machine is older than 2.48 (${host?.join(".") ?? "not found"})`;
    }
    if (reason) {
      onLine(
        `worktree: using absolute links because ${reason}; git commands in it only work inside the container`
      );
    }
    return reason === undefined;
  }

  private hostGitVersion(): Promise<[number, number] | undefined> {
    this.hostVersion ??= this.deps
      .run("git", ["--version"], { timeoutMs: 10_000 })
      .then((r) => (r.exitCode === 0 ? parseGitVersion(r.stdout) : undefined));
    return this.hostVersion;
  }

  private async git(project: Project, ws: string, args: string[]) {
    const r = await this.deps.containers.exec(
      project,
      ["git", "-C", ws, ...args],
      { timeoutMs: GIT_TIMEOUT_MS }
    );
    if (r.exitCode !== 0) {
      const tail = tailLines(`${r.stderr}\n${r.stdout}`, 5);
      throw new CommandError(
        `git ${args.slice(0, 2).join(" ")} failed: ${tail.at(-1) ?? `exit ${r.exitCode}`}`,
        tail
      );
    }
    return r;
  }
}
