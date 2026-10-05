import type { Project, UpdateResult, UpdateStrategy } from "../shared/types";
import { CommandError, type Containers, tailLines } from "./containers";
import type { RunResult } from "./exec";
import { baseKey } from "./worktrees";

export type { UpdateResult, UpdateStrategy };

const GIT_TIMEOUT_MS = 120_000;

export const IDENTITY_HINT =
  "git has no user.name/user.email in the container. opendevhub copies them from this machine when the container starts: set them with `git config --global user.name …` and `git config --global user.email …` here (or in the devcontainer), then restart the project.";

/** `git rev-list --left-right --count base...HEAD` prints "<behind>\t<ahead>". */
export function parseAheadBehind(out: string): { ahead: number; behind: number } {
  const [behind, ahead] = out.trim().split(/\s+/).map(Number);
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 };
}

function failure(args: string[], r: RunResult): CommandError {
  const tail = tailLines(r.stderr + "\n" + r.stdout, 5);
  return new CommandError(`git ${args[0]} failed: ${tail.at(-1) ?? `exit ${r.exitCode}`}`, tail);
}

/** Local git work for review, run in the project's container on one checkout. Callers validate refs and paths. */
export class GitOps {
  constructor(private readonly deps: { containers: Pick<Containers, "exec"> }) {}

  /** The object id of each path at HEAD (a tree for folders, a blob for files); undefined where it doesn't exist. */
  async headObjects(p: Project, dir: string, paths: string[]): Promise<(string | undefined)[]> {
    const script = 'd="$1"; shift; for p in "$@"; do git -C "$d" rev-parse --verify --quiet "HEAD:$p" || echo -; done';
    const r = await this.deps.containers.exec(p, ["sh", "-c", script, "sh", dir, ...paths], { timeoutMs: GIT_TIMEOUT_MS });
    if (r.exitCode !== 0) throw failure(["rev-parse"], r);
    const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return paths.map((_, i) => (lines[i] && lines[i] !== "-" ? lines[i] : undefined));
  }

  private exec(p: Project, dir: string, args: string[]): Promise<RunResult> {
    return this.deps.containers.exec(p, ["git", "-C", dir, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  }

  private async git(p: Project, dir: string, args: string[]): Promise<string> {
    const r = await this.exec(p, dir, args);
    if (r.exitCode !== 0) throw failure(args, r);
    return r.stdout;
  }

  private async conflicts(p: Project, dir: string): Promise<string[]> {
    const r = await this.exec(p, dir, ["diff", "--name-only", "--diff-filter=U"]);
    return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  async currentBranch(p: Project, dir: string): Promise<string | undefined> {
    const r = await this.exec(p, dir, ["symbolic-ref", "--short", "-q", "HEAD"]);
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
  }

  /** Local branch names, e.g. to keep generated task branches free. */
  async localBranches(p: Project, dir: string): Promise<string[]> {
    return (await this.git(p, dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]))
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  async recordedBase(p: Project, dir: string, branch: string): Promise<string | undefined> {
    const r = await this.exec(p, dir, ["config", "--get", baseKey(branch)]);
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
  }

  async aheadBehind(p: Project, dir: string, base: string): Promise<{ ahead: number; behind: number }> {
    return parseAheadBehind(await this.git(p, dir, ["rev-list", "--left-right", "--count", `${base}...HEAD`]));
  }

  async isClean(p: Project, dir: string): Promise<boolean> {
    return (await this.git(p, dir, ["status", "--porcelain"])).trim() === "";
  }

  /** Pushed: the branch has an upstream, or publish recorded it. */
  async isPushed(p: Project, dir: string, branch: string): Promise<boolean> {
    if ((await this.exec(p, dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])).exitCode === 0) return true;
    return (await this.exec(p, dir, ["config", "--get", `branch.${branch}.opendevhubPublished`])).exitCode === 0;
  }

  private async requireIdentity(p: Project, dir: string): Promise<void> {
    for (const key of ["user.name", "user.email"]) {
      const r = await this.exec(p, dir, ["config", key]);
      if (r.exitCode !== 0 || !r.stdout.trim()) throw new CommandError(IDENTITY_HINT);
    }
  }

  async commit(p: Project, dir: string, message: string): Promise<void> {
    await this.requireIdentity(p, dir);
    await this.git(p, dir, ["add", "-A"]);
    await this.git(p, dir, ["commit", "-q", "-m", message]);
  }

  /**
   * Brings `base` into the branch. Any failure (a conflict, a hook, signing, a lock) is aborted, so the checkout
   * is never left mid-way; conflicts are reported, anything else is thrown.
   */
  async update(p: Project, dir: string, base: string, strategy: UpdateStrategy): Promise<UpdateResult> {
    await this.requireIdentity(p, dir);
    const args = strategy === "rebase" ? ["rebase", base] : ["merge", "--no-edit", base];
    const r = await this.exec(p, dir, args);
    if (r.exitCode === 0) return { strategy };
    const conflicts = await this.conflicts(p, dir);
    await this.abort(p, dir, strategy);
    if (conflicts.length === 0) throw failure(args, r);
    return { strategy, conflicts };
  }

  /**
   * Undoes a rebase or merge that stopped part-way. When none is in progress git refuses with "no rebase/merge
   * to abort" and nothing changes; otherwise the abort itself must succeed.
   */
  private async abort(p: Project, dir: string, op: UpdateStrategy): Promise<void> {
    const r = await this.exec(p, dir, [op, "--abort"]);
    if (r.exitCode === 0 || /no rebase in progress|no merge to abort|MERGE_HEAD missing/i.test(r.stderr)) return;
    throw failure([op, "--abort"], r);
  }

  /** Merges `branch` into the checkout at `workspace`, which is on the base. Any failure is aborted. */
  async mergeInto(p: Project, workspace: string, branch: string, ffOnly: boolean): Promise<void> {
    if (!ffOnly) await this.requireIdentity(p, workspace);
    const args = ["merge", ffOnly ? "--ff-only" : "--no-ff", "--no-edit", branch];
    const r = await this.exec(p, workspace, args);
    if (r.exitCode === 0) return;
    const conflicts = await this.conflicts(p, workspace);
    await this.abort(p, workspace, "merge");
    if (conflicts.length === 0) throw failure(args, r);
    throw new CommandError(
      `merging ${branch} conflicts in ${conflicts.join(", ")}; nothing was merged. Update the branch from its base first.`,
      conflicts,
    );
  }

  /** `-d` refuses a branch that isn't merged; `force` (-D) is for branches the user chose to discard. */
  async deleteBranch(p: Project, workspace: string, branch: string, force = false): Promise<void> {
    await this.git(p, workspace, ["branch", force ? "-D" : "-d", branch]);
  }
}
