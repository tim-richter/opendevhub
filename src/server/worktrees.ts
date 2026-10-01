import path from "node:path";
import type { Project, Worktree, WorktreeRoot } from "../shared/types";
import { CommandError, type Containers, tailLines } from "./containers";
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
export function worktreeRoot(projectPath: string, workspaceFolder: string, mounted: boolean): WorktreeRoot {
  return {
    host: projectPath + WORKTREES_SUFFIX,
    container: path.posix.normalize(workspaceFolder).replace(/\/$/, "") + WORKTREES_SUFFIX,
    mounted,
  };
}

export function mountArg(root: WorktreeRoot): string {
  return `type=bind,source=${root.host},target=${root.container}`;
}

export function parseGitVersion(output: string): [number, number] | undefined {
  const m = output.match(/git version (\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

export function supportsRelativePaths(version: [number, number] | undefined): boolean {
  if (!version) return false;
  const [major, minor] = version;
  return major > RELATIVE_PATHS_SINCE[0] || (major === RELATIVE_PATHS_SINCE[0] && minor >= RELATIVE_PATHS_SINCE[1]);
}

/** Branch names users may pick: a safe subset of git's rules (no spaces, `..`, leading `-`, `.lock`…). */
export function validateBranch(name: string): string {
  const branch = name.trim();
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) ||
    branch.length > 100 ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.endsWith(".lock") ||
    branch.split("/").some((part) => part.startsWith("."))
  ) {
    throw new InvalidRequestError(
      `invalid branch name "${name}": use letters, digits, ".", "_", "-" and "/" (not leading, trailing or doubled)`,
    );
  }
  return branch;
}

/** The folder a branch's worktree gets under the worktrees root: `feature/login` → `feature-login`. */
export function worktreeDirName(branch: string): string {
  return branch.replace(/\//g, "-");
}

/** Linked worktrees from `git worktree list --porcelain` (the main checkout and bare entries are dropped). */
export function parseWorktreeList(porcelain: string, root: WorktreeRoot | undefined): Worktree[] {
  const blocks = porcelain.split(/\n\s*\n/).filter((b) => b.trim());
  const out: Worktree[] = [];
  blocks.forEach((block, i) => {
    let wt: Worktree | undefined;
    let bare = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) wt = { path: line.slice("worktree ".length) };
      else if (line.startsWith("HEAD ") && wt) wt.head = line.slice(5);
      else if (line.startsWith("branch ") && wt) wt.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "bare") bare = true;
    }
    if (!wt || bare || i === 0) return;
    if (root?.mounted) {
      const rel = path.posix.relative(root.container, wt.path);
      if (rel && !rel.startsWith("..") && !path.posix.isAbsolute(rel)) wt.hostPath = path.join(root.host, rel);
    }
    out.push(wt);
  });
  return out;
}

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

  constructor(
    private readonly deps: {
      containers: Pick<Containers, "exec">;
      run: Runner;
      /** false forces absolute links, for repos also opened by libgit2-based tools that reject relative ones. */
      relativeLinks?: boolean;
    },
  ) {}

  async list(project: Project, workspaceFolder: string, root: WorktreeRoot | undefined): Promise<Worktree[]> {
    const r = await this.git(project, workspaceFolder, ["worktree", "list", "--porcelain"]);
    return parseWorktreeList(r.stdout, root);
  }

  async add(project: Project, args: AddWorktreeArgs): Promise<Worktree> {
    const { workspaceFolder: ws, root, branch, base, onLine } = args;
    if (base !== undefined && (base.startsWith("-") || /\s/.test(base) || base === "")) {
      throw new InvalidRequestError(`invalid base "${base}"`);
    }
    const top = (await this.git(project, ws, ["rev-parse", "--show-toplevel"])).stdout.trim();
    if (path.posix.normalize(top) !== path.posix.normalize(ws)) {
      throw new InvalidRequestError(`worktrees need the workspace folder to be the git root (git root is ${top})`);
    }
    const target = path.posix.join(root.container, worktreeDirName(branch));
    const relative = await this.relativeLinks(project, ws, root, onLine);
    const exists =
      (await this.deps.containers.exec(project, ["git", "-C", ws, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]))
        .exitCode === 0;
    const cmd = ["worktree", "add"];
    if (relative) cmd.push("--relative-paths");
    if (exists) {
      if (base) throw new InvalidRequestError(`branch ${branch} already exists; leave the base empty to check it out`);
      cmd.push("--", target, branch);
    } else {
      cmd.push("-b", branch, "--", target);
      if (base) cmd.push(base);
    }
    await this.git(project, ws, cmd);
    onLine(`worktree: added ${target} (${exists ? "existing" : "new"} branch ${branch}${relative ? "" : ", absolute links"})`);
    const hostPath = root.mounted ? path.join(root.host, worktreeDirName(branch)) : undefined;
    return { path: target, hostPath, branch };
  }

  async remove(project: Project, workspaceFolder: string, worktreePath: string, force: boolean): Promise<void> {
    const cmd = ["worktree", "remove"];
    if (force) cmd.push("--force");
    await this.git(project, workspaceFolder, [...cmd, "--", worktreePath]);
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
    onLine: (line: string) => void,
  ): Promise<boolean> {
    if (!root.mounted) return false;
    if (this.deps.relativeLinks === false) {
      onLine("worktree: using absolute links (OPENDEVHUB_RELATIVE_WORKTREES=0); git commands in it only work inside the container");
      return false;
    }
    const container = parseGitVersion((await this.deps.containers.exec(project, ["git", "--version"])).stdout);
    const host = await this.hostGitVersion();
    let reason: string | undefined;
    if (path.posix.basename(ws) !== path.basename(project.path)) {
      reason = `the workspace folder (${ws}) is named differently from ${project.path}`;
    } else if (!supportsRelativePaths(container)) {
      reason = `git in the container is older than 2.48 (${container?.join(".") ?? "unknown"})`;
    } else if (!supportsRelativePaths(host)) {
      reason = `git on this machine is older than 2.48 (${host?.join(".") ?? "not found"})`;
    }
    if (reason) onLine(`worktree: using absolute links because ${reason}; git commands in it only work inside the container`);
    return reason === undefined;
  }

  private hostGitVersion(): Promise<[number, number] | undefined> {
    this.hostVersion ??= this.deps
      .run("git", ["--version"], { timeoutMs: 10_000 })
      .then((r) => (r.exitCode === 0 ? parseGitVersion(r.stdout) : undefined));
    return this.hostVersion;
  }

  private async git(project: Project, ws: string, args: string[]) {
    const r = await this.deps.containers.exec(project, ["git", "-C", ws, ...args], { timeoutMs: GIT_TIMEOUT_MS });
    if (r.exitCode !== 0) {
      const tail = tailLines(r.stderr + "\n" + r.stdout, 5);
      throw new CommandError(`git ${args.slice(0, 2).join(" ")} failed: ${tail.at(-1) ?? `exit ${r.exitCode}`}`, tail);
    }
    return r;
  }
}
