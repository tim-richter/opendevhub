import path from "node:path";

import type {
  BranchView,
  Project,
  ProjectId,
  Worktree,
} from "../../shared/types";
import { creatorView } from "../db/checkouts";
import { USER } from "../db/events";
import type { CheckTarget } from "../environments/checks";
import type { ExecTarget } from "../environments/containers";
import type { Environments, TaskEnv } from "../environments/environments";
import { repoOf } from "../environments/ports";
import type { GitPort, HubDeps } from "../environments/ports";
import { BusyError, UnavailableError } from "../errors";
import type { Sessions } from "../sessions/sessions";
import {
  InvalidRequestError,
  validateBranch,
  worktreeDirName,
} from "./worktrees";

const NO_WORKTREE_MOUNT =
  "this container was created before opendevhub mounted a worktrees folder — rebuild the container to enable worktrees";

/** A project's checkouts: the workspace and its worktrees, here or in an environment on another node. */
export class Checkouts {
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  private readonly sessions: Sessions;
  constructor(deps: HubDeps, envs: Environments, sessions: Sessions) {
    this.deps = deps;
    this.envs = envs;
    this.sessions = sessions;
  }

  /** The project's branch rows, deleted ones and those whose worktrees are gone included. */
  branches(id: ProjectId): BranchView[] {
    this.envs.requireProject(id);
    return this.deps.checkouts.branchesOf(id).map((b) => ({
      createdAt: b.createdAt,
      createdBy: creatorView(b.createdBy, {
        ...(b.createdBy.by === "variant"
          ? { title: this.deps.tasks.get(b.createdBy.task)?.title }
          : {}),
        ...(b.originUrl ? { url: b.originUrl } : {}),
      }),
      id: b.id,
      name: b.name,
      ...(b.base ? { base: b.base } : {}),
      ...(b.originUrl ? { origin: b.originUrl } : {}),
      ...(b.publishedRemote ? { publishedRemote: b.publishedRemote } : {}),
      ...(b.publishedAt === undefined ? {} : { publishedAt: b.publishedAt }),
      ...(b.prUrl ? { prUrl: b.prUrl } : {}),
      ...(b.deletedAt === undefined ? {} : { deletedAt: b.deletedAt }),
    }));
  }

  /** Re-reads `git worktree list` in the container. */
  refreshWorktrees(id: ProjectId): Promise<Worktree[]> {
    return this.envs.withGit(id, async (p) => {
      const ws = this.envs.workspaceFolder(p);
      const list = await this.deps.worktrees.list(
        p,
        ws,
        this.deps.store.runtime(id).worktreeRoot
      );
      this.envs.setWorktrees(id, list);
      return list;
    });
  }

  createWorktree(
    id: ProjectId,
    req: {
      branch: string;
      base?: string;
      startSession?: boolean;
      prompt?: string;
      pull?: { url: string; number: number; commitId: string };
    }
  ): Promise<{ worktree: Worktree; sessionId?: string }> {
    const branch = validateBranch(req.branch);
    const base = req.base?.trim() || undefined;
    return this.envs.withGit(id, async (p) => {
      const rt = this.deps.store.runtime(id);
      const root = rt.worktreeRoot;
      if (!root?.mounted) {
        throw new UnavailableError(NO_WORKTREE_MOUNT);
      }
      const target = path.posix.join(root.container, worktreeDirName(branch));
      const held = this.deps.store
        .environments(id)
        .find((e) => e.node && e.worktree.path === target);
      if (held) {
        throw new InvalidRequestError(
          `${target} is used by a task on node ${held.node}; remove that task first`
        );
      }
      const ws = this.envs.workspaceFolder(p);
      const worktree = await this.deps.worktrees.add(p, {
        base: req.pull
          ? await this.deps.git.fetchPull(
              p,
              ws,
              req.pull.url,
              req.pull.number,
              req.pull.commitId
            )
          : base,
        branch,
        onLine: (l) => this.envs.log(id, l),
        root,
        workspaceFolder: ws,
      });
      this.deps.checkouts.recordCreated(
        id,
        {
          branch,
          path: worktree.path,
          ...(worktree.hostPath ? { hostPath: worktree.hostPath } : {}),
          ...(worktree.base ? { base: worktree.base } : {}),
          ...(req.pull ? { originUrl: req.pull.url } : {}),
        },
        req.pull ? { by: "pull" } : { by: "manual" },
        USER
      );
      const { base: _base, ...created } = worktree;
      await this.deps.worktrees.list(p, ws, root).then(
        (list) => this.envs.setWorktrees(id, list),
        () =>
          this.deps.store.updateRuntime(id, {
            worktrees: [...(rt.worktrees ?? []), created],
          })
      );
      if (!req.startSession) {
        return { worktree: created };
      }
      const sessionId = await this.sessions
        .startSession(id, created.path, branch, req.prompt)
        .catch((error: unknown) => {
          this.envs.log(
            id,
            `worktree: could not start a session: ${error instanceof Error ? error.message : String(error)}`
          );
          return undefined;
        });
      return { sessionId, worktree: created };
    });
  }

  removeWorktree(
    id: ProjectId,
    worktreePath: string,
    force: boolean,
    deleteBranch = false
  ): Promise<void> {
    const remote = this.envs.remoteEnvAt(
      this.envs.requireProject(id),
      worktreePath
    );
    if (remote) {
      this.envs.kit(remote);
      return this.envs.destroy(remote);
    }
    return this.envs.withGit(id, async (p) => {
      const known = this.deps.store.runtime(id).worktrees ?? [];
      const target = known.find((w) => w.path === worktreePath);
      if (!target) {
        throw new InvalidRequestError(`unknown worktree ${worktreePath}`);
      }
      const ws = this.envs.workspaceFolder(p);
      await this.dropWorktree(p, worktreePath, force);
      try {
        const targetBranch = target.branch;
        if (deleteBranch && targetBranch) {
          await this.envs.gitAction(id, `delete branch ${targetBranch}`, () =>
            this.deps.git.deleteBranch(p, ws, targetBranch)
          );
          this.deps.checkouts.deleteBranch(id, targetBranch, USER);
        }
      } finally {
        // The worktree is gone either way; don't keep listing it when only the branch delete failed.
        await this.deps.worktrees
          .list(p, ws, this.deps.store.runtime(id).worktreeRoot)
          .then(
            (list) => this.envs.setWorktrees(id, list),
            () =>
              this.deps.store.updateRuntime(id, {
                worktrees: known.filter((w) => w.path !== worktreePath),
              })
          );
      }
    });
  }

  /** Removes a worktree and its own container first; keeps the worktree when the container won't go. */
  async dropWorktree(
    p: Project,
    worktreePath: string,
    force: boolean
  ): Promise<void> {
    const rec = this.deps.store
      .environments(p.id)
      .find((e) => e.worktree.path === worktreePath);
    if (rec) {
      const env = this.envs.taskEnv(p, rec);
      try {
        await this.envs.destroy(env);
      } catch (error) {
        if (error instanceof BusyError) {
          throw error;
        }
        throw new UnavailableError(
          `kept the worktree: its container could not be removed (${error instanceof Error ? error.message : String(error)})`
        );
      }
    }
    await this.deps.worktrees.remove(
      p,
      this.envs.workspaceFolder(p),
      worktreePath,
      force
    );
    this.deps.checkouts.removeWorktree(p.id, worktreePath, undefined, USER);
    this.envs.log(p.id, `worktree: removed ${worktreePath}`);
  }

  /** Where git runs for a checkout: the project's container, or a remote environment's own. */
  gitFor(
    project: Project,
    directory: string
  ): { git: GitPort; target: ExecTarget; remote?: TaskEnv } {
    const remote = this.envs.remoteEnvAt(project, directory);
    if (!remote) {
      return { git: this.deps.git, target: project };
    }
    return { git: this.envs.kit(remote).git, remote, target: remote.target };
  }

  /** Fetches a remote environment's branch into this machine's repository. */
  bringHome(id: ProjectId, directory: string): Promise<{ branch: string }> {
    this.envs.checkDirectory(id, directory);
    return this.envs.withGit(id, (p) => this.fetchHome(p, directory));
  }

  async fetchHome(p: Project, directory: string): Promise<{ branch: string }> {
    const remote = this.envs.remoteEnvAt(p, directory);
    if (!remote) {
      throw new InvalidRequestError(`${directory} is on this machine already`);
    }
    const kit = this.envs.kit(remote);
    const branch = validateBranch(
      (await kit.git.currentBranch(remote.target, directory)) ??
        remote.worktree.branch
    );
    const repo = repoOf(kit);
    const layout = repo.layout(p, this.envs.workspaceFolder(p));
    await this.envs.gitAction(
      p.id,
      `bring ${branch} home from node ${remote.node}`,
      () => repo.bringHome(p, layout, branch)
    );
    return { branch };
  }

  /** A checkout as checks run it: its environment (and whether it runs) and its host folder. */
  checkTarget(id: ProjectId, directory: string): CheckTarget {
    const project = this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    const remote = this.envs.remoteEnvAt(project, directory);
    if (remote) {
      return {
        checkout: { container: directory },
        exec: remote.target,
        isMain: false,
        project,
        unavailable: "checks don't run on other nodes yet",
      };
    }
    const env = this.envs.envForDirectory(project, directory);
    const running =
      this.deps.store.runtime(env.id).containerState === "running";
    return {
      project,
      exec: env.target,
      ...(running
        ? {}
        : {
            unavailable: env.worktree
              ? "this worktree's container is not running — start it from the Worktrees tab"
              : "the project's container is not running",
          }),
      checkout: this.checkout(project, directory),
      isMain: directory === this.envs.workspaceFolder(project),
    };
  }

  /** Opens the workspace or a worktree in an editor on this machine. */
  openInEditor(
    id: ProjectId,
    editorId: string,
    directory: string
  ): Promise<void> {
    const project = this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    if (this.envs.remoteEnvAt(project, directory)) {
      throw new InvalidRequestError(
        "opening an editor isn't available for environments on other nodes"
      );
    }
    const rt = this.deps.store.runtime(id);
    const hostPath =
      directory === this.envs.workspaceFolder(project)
        ? project.path
        : rt.worktrees?.find((w) => w.path === directory)?.hostPath;
    const envRt = this.deps.store.runtime(
      this.envs.envForDirectory(project, directory).id
    );
    return this.deps.editors.open(editorId, {
      containerName:
        envRt.containerState === "running" ? envRt.containerName : undefined,
      containerPath: directory,
      hostPath,
    });
  }

  /** The checkout as the container sees it, plus where it lives on this machine when it does. */
  checkout(
    project: Project,
    directory: string
  ): { container: string; host?: string } {
    if (directory === this.envs.workspaceFolder(project)) {
      return { container: directory, host: project.path };
    }
    const hostPath = this.deps.store
      .runtime(project.id)
      .worktrees?.find((w) => w.path === directory)?.hostPath;
    return { container: directory, ...(hostPath ? { host: hostPath } : {}) };
  }
}
