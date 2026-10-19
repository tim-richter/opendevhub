import {
  FIRST_TURN_SENDING,
  firstTurnUnconfirmed,
  taskBranches,
} from "../../shared/tasks";
import type {
  ComposerSendRequest,
  EnvId,
  EnvWorktree,
  Isolation,
  NodeId,
  Project,
  TaskVariantResult,
  TaskVariantSpec,
  TaskWhere,
} from "../../shared/types";
import type { Creator } from "../db/checkouts";
import type { Actor } from "../db/events";
import type { VariantPatch } from "../db/tasks";
import { CommandError } from "../environments/containers";
import type { EnvSetup, Environments } from "../environments/environments";
import { cleanLogLine } from "../environments/log-buffer";
import type { HubDeps, NodeKit } from "../environments/ports";
import { UnavailableError } from "../errors";
import { InvalidRequestError, validateBranch } from "../git/worktrees";
import type { NodeRepoLayout } from "../nodes/repo";
import type { OpencodeClient } from "../opencode/client";
import { resolveMessage } from "../sessions/message";
import type { ResolvedMessage } from "../sessions/message";

/** A checkout's first turn: an OpenSpec command or the prompt, or a composer message resolved in its checkout. */
export type FirstTurn =
  | { command?: string; text: string }
  | { message: ComposerSendRequest };

export const NO_WORKTREE_MOUNT =
  "this container was created before opendevhub mounted a worktrees folder — rebuild the container to enable worktrees";

/**
 * How long the first turn may take to be accepted. opencode has just started in a fresh container and does its
 * heavier first-turn work (indexing the checkout, warming up the provider) only when the first message arrives.
 */
export const FIRST_TURN_TIMEOUT_MS = 60_000;

/**
 * Where one checkout's setup reports: a task variant's row, or a chat's. Each step, the setup's log lines and the
 * session once it exists go here.
 */
export interface SetupSink {
  /** Who the setup acts as in the events it causes. */
  actor: Actor;
  /** Recorded as the creator of the worktree and branch the setup makes. */
  creator: Creator;
  /** The task an environment started for this checkout is recorded for. */
  taskId?: string;
  step: (patch: VariantPatch) => void;
  log: (line: string) => void;
  /**
   * Links the session the setup just created, with `note` as its error until the first message is confirmed; called
   * while the directory is claimed, so reconcile leaves it alone.
   */
  attach: (session: {
    sessionId: string;
    envId: EnvId;
    directory: string;
    note?: string;
  }) => void;
  /** The worktree and branch rows the setup recorded. */
  created?: (rows: { branchId: number; worktreeId: number }) => void;
  /** Whether the checkout was given up on meanwhile (a discarded variant): its setup stops at the next step. */
  cancelled?: () => boolean;
}

/** A checkout given up on while it was being set up; it gets no container, session or first message. */
class DiscardedError extends Error {
  constructor() {
    super("discarded while it was starting");
    this.name = "DiscardedError";
  }
}

const stopIfCancelled = (sink: SetupSink): void => {
  if (sink.cancelled?.()) {
    throw new DiscardedError();
  }
};

/** One checkout to set up: where it reports, and its session's title, model and agent. */
export interface SetupSlot {
  sink: SetupSink;
  sessionTitle: string;
  spec: TaskVariantSpec;
}

export interface SetupJob {
  /** `task <title>` or `chat <title>`, for the project's log. */
  label: string;
  /** What branch names are made from. */
  title: string;
  where: TaskWhere;
  directory?: string;
  branch?: string;
  base?: string;
  environment?: Isolation;
  node: NodeId;
  remoteKit?: NodeKit;
  slots: SetupSlot[];
  turn: FirstTurn;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Sets up checkouts and starts a session in each: a worktree (unless it runs in the main checkout), its own
 * environment when isolated, a session recorded through the slot's sink, then the first turn. Worktrees are created
 * in order under one git lock; a failing slot is recorded on its sink and the others still run, and worktrees
 * already created are kept. Isolated slots then start their own containers in parallel and get their sessions there.
 */
export class CheckoutSetup {
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  constructor(deps: HubDeps, envs: Environments) {
    this.deps = deps;
    this.envs = envs;
  }

  /** Runs the job; when it fails as a whole, every slot that has no session and hasn't failed yet records why. */
  async run(
    project: Project,
    client: OpencodeClient,
    job: SetupJob
  ): Promise<TaskVariantResult[]> {
    const settled = new Set<number>();
    try {
      return await this.setUp(project, client, job, settled);
    } catch (error) {
      for (const [i, slot] of job.slots.entries()) {
        if (!settled.has(i)) {
          slot.sink.step({ error: message(error), step: "failed" });
        }
      }
      this.envs.log(
        project.id,
        `${job.label}: could not start: ${message(error)}`
      );
      throw error;
    }
  }

  private async setUp(
    project: Project,
    client: OpencodeClient,
    job: SetupJob,
    settled: Set<number>
  ): Promise<TaskVariantResult[]> {
    const { remoteKit, node, slots, turn, label } = job;
    const { id } = project;
    const { store } = this.deps;
    const localIsolation = () =>
      job.where === "workspace"
        ? { isolated: false, notice: undefined }
        : this.envs.isolationFor(project, job.environment);
    const { isolated, notice } = remoteKit
      ? { isolated: true, notice: undefined }
      : localIsolation();
    const own: (EnvWorktree | undefined)[] = [];
    /** Where each slot that runs in an existing container starts its session, once the git lock is released. */
    const shared: (string | undefined)[] = [];
    const step = (i: number, patch: VariantPatch) => slots[i].sink.step(patch);
    const fail = (
      i: number,
      branch: string | undefined,
      result: TaskVariantResult,
      error: unknown
    ) => {
      this.failed(id, label, i, branch, result, error);
      settled.add(i);
      step(i, { error: result.error, step: "failed" });
    };
    const results = await this.envs.withGitWhenFree(id, async (p) => {
      const rt = store.runtime(id);
      const ws = this.envs.workspaceFolder(p);
      const root = rt.worktreeRoot;
      let branches: string[] = [];
      let remote:
        | { layout: NodeRepoLayout; base: string; notice?: string }
        | undefined;
      if (job.where === "worktree") {
        if (!remoteKit && !root?.mounted) {
          throw new UnavailableError(NO_WORKTREE_MOUNT);
        }
        if (remoteKit) {
          for (const [i] of slots.entries()) {
            step(i, { step: "pushing" });
          }
          remote = await this.prepareRemote(p, ws, remoteKit, node, job.base);
        }
        const taken = new Set([
          ...(await this.deps.git.localBranches(p, ws)),
          ...(rt.worktrees ?? []).flatMap((w) => (w.branch ? [w.branch] : [])),
          ...(remote && remoteKit
            ? await remoteKit.repo.branches(remote.layout)
            : []),
        ]);
        branches = taskBranches({
          branch: job.branch,
          taken,
          title: job.title,
          variants: slots.map((s) => s.spec),
        }).map(validateBranch);
      }
      const slotResults: TaskVariantResult[] = [];
      for (const [i, slot] of slots.entries()) {
        const { sink } = slot;
        const branch = branches[i];
        const existing =
          job.where === "existing"
            ? rt.worktrees?.find(
                (worktree) => worktree.path === job.directory && !worktree.node
              )
            : undefined;
        const result: TaskVariantResult = branch
          ? { branch }
          : {
              directory: existing?.path ?? ws,
              ...(existing?.branch ? { branch: existing.branch } : {}),
            };
        if (notice) {
          result.notice = notice;
        }
        if (remote?.notice) {
          result.notice = remote.notice;
        }
        slotResults.push(result);
        const onLine = (l: string) => this.slotLog(id, sink, l);
        try {
          stopIfCancelled(sink);
          if (job.where === "existing") {
            if (!existing) {
              throw new InvalidRequestError(
                "the selected worktree is no longer available"
              );
            }
            if (isolated) {
              if (!existing.hostPath || !existing.branch) {
                throw new InvalidRequestError(
                  "this worktree cannot run in its own container"
                );
              }
              own[i] = {
                branch: existing.branch,
                hostPath: existing.hostPath,
                path: existing.path,
              };
              continue;
            }
          }
          if (branch && remote && remoteKit) {
            step(i, { branch, step: "worktree" });
            const wt = await remoteKit.repo.addWorktree(
              remote.layout,
              branch,
              remote.base
            );
            const rows = this.deps.checkouts.recordCreated(
              id,
              {
                base: remote.base,
                branch,
                hostPath: wt.hostPath,
                node,
                path: wt.path,
              },
              sink.creator,
              sink.actor
            );
            sink.created?.({
              branchId: rows.branch.id,
              worktreeId: rows.worktree.id,
            });
            result.directory = wt.path;
            step(i, { directory: wt.path });
            own[i] = wt;
            continue;
          }
          if (branch) {
            if (!root) {
              throw new UnavailableError(NO_WORKTREE_MOUNT);
            }
            step(i, { branch, step: "worktree" });
            const wt = await this.deps.worktrees.add(p, {
              base: job.base,
              branch,
              onLine,
              root,
              workspaceFolder: ws,
            });
            const rows = this.deps.checkouts.recordCreated(
              id,
              {
                branch,
                path: wt.path,
                ...(wt.hostPath ? { hostPath: wt.hostPath } : {}),
                ...(wt.base ? { base: wt.base } : {}),
              },
              sink.creator,
              sink.actor
            );
            sink.created?.({
              branchId: rows.branch.id,
              worktreeId: rows.worktree.id,
            });
            result.directory = wt.path;
            step(i, { directory: wt.path });
            if (isolated && wt.hostPath) {
              own[i] = { branch, hostPath: wt.hostPath, path: wt.path };
              continue;
            }
          }
          step(i, { step: "session" });
          shared[i] = result.directory ?? ws;
        } catch (error) {
          fail(i, branch, result, error);
        }
      }
      if (branches.length > 0 && !remote) {
        const created = slotResults.flatMap((r) =>
          r.branch && r.directory
            ? [{ branch: r.branch, path: r.directory }]
            : []
        );
        await this.deps.worktrees.list(p, ws, root).then(
          (list) => this.envs.setWorktrees(id, list),
          () => {
            const known = rt.worktrees ?? [];
            store.updateRuntime(id, {
              worktrees: [
                ...known,
                ...created.filter((c) => !known.some((w) => w.path === c.path)),
              ],
            });
          }
        );
      }
      return slotResults;
    });
    // Sessions start outside the git lock: a slow first turn must not hold up every other git action on the project.
    const startShared = shared.map(async (directory, i) => {
      if (directory === undefined) {
        return;
      }
      const result = results[i];
      try {
        await this.startSession(client, id, slots[i], result, directory, turn);
        settled.add(i);
      } catch (error) {
        fail(i, result.branch, result, error);
      }
    });
    await Promise.all([
      ...startShared,
      ...own.map(async (worktree, i) => {
        if (!worktree) {
          return;
        }
        const result = results[i];
        const slot = slots[i];
        try {
          stopIfCancelled(slot.sink);
          const env = await this.envs
            .ensureTaskEnv(project, worktree, node, this.envSetup(slot.sink))
            .catch((error: unknown) => {
              if (slot.sink.cancelled?.()) {
                throw new DiscardedError();
              }
              throw new Error(`its container did not start: ${message(error)}`);
            });
          if (slot.sink.cancelled?.()) {
            // Its container was started for it alone; the worktree and branch stay.
            await this.envs.destroy(env).catch(() => undefined);
            throw new DiscardedError();
          }
          result.envId = env.id;
          step(i, { envId: env.id, step: "session" });
          await this.startSession(
            this.envs.opencodeClient(env.id),
            env.id,
            slot,
            result,
            worktree.path,
            turn
          );
          settled.add(i);
        } catch (error) {
          fail(i, worktree.branch, result, error);
        }
      }),
    ]);
    const started = results.filter((r) => r.sessionId).length;
    const of = slots.length;
    this.envs.log(
      id,
      `${label}: started ${started} of ${of} variant${of === 1 ? "" : "s"}`
    );
    this.envs.reconcile(id);
    for (const r of results) {
      if (r.envId) {
        this.envs.reconcile(r.envId);
      }
    }
    return results;
  }

  /** What an environment started for a slot reports to: its sink's image and container steps and log. */
  private envSetup(sink: SetupSink): EnvSetup {
    return {
      actor: sink.actor,
      log: (line) => sink.log(line),
      step: (s) => sink.step({ step: s }),
      ...(sink.cancelled ? { cancelled: sink.cancelled } : {}),
      ...(sink.taskId ? { taskId: sink.taskId } : {}),
    };
  }

  /** A line of a starting checkout's setup: in the project's log and in the checkout's own. */
  private slotLog(id: string, sink: SetupSink, raw: string): void {
    this.envs.log(id, raw);
    const line = cleanLogLine(raw);
    if (line) {
      sink.log(line);
    }
  }

  /** The node's repository for the project, with the base pushed to it. */
  private async prepareRemote(
    p: Project,
    ws: string,
    kit: NodeKit,
    node: NodeId,
    requested: string | undefined
  ): Promise<{ layout: NodeRepoLayout; base: string; notice?: string }> {
    const base = requested ?? (await this.deps.git.currentBranch(p, ws));
    if (!base) {
      throw new InvalidRequestError(
        "the main checkout is on a detached HEAD; choose a base branch for a task on another node"
      );
    }
    const layout = kit.repo.layout(p, ws);
    await kit.repo.ensure(layout);
    await kit.repo.pushBase(p, layout, base);
    this.envs.log(p.id, `task: pushed ${base} to node ${node}`);
    const clean = await this.deps.git.isClean(p, ws);
    return {
      base,
      layout,
      ...(clean
        ? {}
        : {
            notice: `uncommitted changes in the main checkout are not on node ${node}`,
          }),
    };
  }

  /**
   * Creates a slot's session (recorded on the result and through its sink at once) and sends its first turn: the
   * prompt, the composer's message (resolved first, so that a bad mention leaves no session), or an OpenSpec
   * command, checked first so that a missing command leaves no session. The directory is claimed meanwhile, so that
   * reconcile doesn't adopt the session as a chat.
   */
  private async startSession(
    client: OpencodeClient,
    envId: EnvId,
    slot: SetupSlot,
    result: TaskVariantResult,
    directory: string,
    turn: FirstTurn
  ): Promise<void> {
    const resolved: ResolvedMessage =
      "message" in turn
        ? await resolveMessage(
            () => client.commands(directory, FIRST_TURN_TIMEOUT_MS),
            directory,
            turn.message
          )
        : { attachments: {}, ...turn };
    const { command } = resolved;
    if (command && !("message" in turn)) {
      const commands = await client.commands(directory, FIRST_TURN_TIMEOUT_MS);
      if (!commands.some((c) => c.name === command)) {
        throw new UnavailableError(
          `opencode has no ${command} command here; run \`openspec init --tools opencode\` in the repository`
        );
      }
    }
    const { spec, sink } = slot;
    stopIfCancelled(sink);
    const release = this.deps.tasks.claim(envId, directory);
    try {
      const session = await client.createSession(
        directory,
        {
          title: slot.sessionTitle,
          ...(spec.model ? { model: spec.model } : {}),
          ...(spec.agent ? { agent: spec.agent } : {}),
        },
        FIRST_TURN_TIMEOUT_MS
      );
      result.sessionId = session.id;
      sink.attach({
        directory,
        envId,
        note: FIRST_TURN_SENDING,
        sessionId: session.id,
      });
    } finally {
      release();
    }
    // Discarded while its session was being created: it stays empty, and hidden with its variant.
    stopIfCancelled(sink);
    const { sessionId } = result;
    const { attachments, text } = resolved;
    try {
      await (command
        ? client.command(sessionId, command, text, directory, {
            ...attachments,
            timeoutMs: FIRST_TURN_TIMEOUT_MS,
          })
        : client.prompt(
            sessionId,
            text,
            undefined,
            directory,
            attachments,
            FIRST_TURN_TIMEOUT_MS
          ));
    } catch (error) {
      // The conversation exists and opencode may well have taken the message (a timeout says nothing about that), so
      // the checkout runs on, with a note instead of a failure.
      const note = firstTurnUnconfirmed(message(error));
      result.notice = note;
      sink.step({ error: note });
      sink.log(note);
      return;
    }
    sink.step({ error: null });
  }

  private failed(
    id: string,
    label: string,
    i: number,
    branch: string | undefined,
    result: TaskVariantResult,
    err: unknown
  ): void {
    result.error = message(err);
    this.envs.log(
      id,
      `${label}: variant ${i + 1}${branch ? ` (${branch})` : ""} failed: ${result.error}`
    );
    if (err instanceof CommandError) {
      for (const line of err.tail) {
        this.envs.log(id, line);
      }
    }
  }
}
