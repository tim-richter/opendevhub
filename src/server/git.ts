import type { Project, UpdateResult, UpdateStrategy } from "../shared/types";
import { CommandError, type Containers, tailLines } from "./containers";
import type { RunResult } from "./exec";
import { baseKey } from "./worktrees";

export type { UpdateResult, UpdateStrategy };

const GIT_TIMEOUT_MS = 120_000;

export const IDENTITY_HINT =
  "git has no user.name/user.email in the container. Set them in the devcontainer, e.g. run `git config --global user.name …` and `git config --global user.email …` in postCreateCommand.";

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

  /** Brings `base` into the branch. On a conflict it aborts, so the checkout is never left mid-way, and lists the files. */
  async update(p: Project, dir: string, base: string, strategy: UpdateStrategy): Promise<UpdateResult> {
    await this.requireIdentity(p, dir);
    const args = strategy === "rebase" ? ["rebase", base] : ["merge", "--no-edit", base];
    const r = await this.exec(p, dir, args);
    if (r.exitCode === 0) return { strategy };
    const conflicts = await this.conflicts(p, dir);
    if (conflicts.length === 0) throw failure(args, r);
    const abort = await this.exec(p, dir, [strategy, "--abort"]);
    if (abort.exitCode !== 0) throw failure([strategy, "--abort"], abort);
    return { strategy, conflicts };
  }

  /** Merges `branch` into the checkout at `workspace`, which is on the base. A conflict is aborted. */
  async mergeInto(p: Project, workspace: string, branch: string, ffOnly: boolean): Promise<void> {
    if (!ffOnly) await this.requireIdentity(p, workspace);
    const args = ["merge", ffOnly ? "--ff-only" : "--no-ff", "--no-edit", branch];
    const r = await this.exec(p, workspace, args);
    if (r.exitCode === 0) return;
    const conflicts = await this.conflicts(p, workspace);
    if (conflicts.length === 0) throw failure(args, r);
    await this.exec(p, workspace, ["merge", "--abort"]);
    throw new CommandError(
      `merging ${branch} conflicts in ${conflicts.join(", ")}; nothing was merged. Update the branch from its base first.`,
      conflicts,
    );
  }

  async deleteBranch(p: Project, workspace: string, branch: string): Promise<void> {
    await this.git(p, workspace, ["branch", "-d", branch]);
  }
}
