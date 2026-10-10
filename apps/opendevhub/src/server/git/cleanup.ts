import type {
  BranchCleanupItem,
  CleanupItem,
  CleanupOutcome,
  CleanupPlan,
  CleanupProject,
  CleanupResult,
  ContainerCleanupItem,
  EnvId,
  ImageCleanupItem,
  Project,
  ProjectId,
  SessionCleanupItem,
  TaskCleanupItem,
  Worktree,
} from "../../shared/types";
import { USER } from "../db/events";
import type { TaskStore } from "../db/tasks";
import type {
  ContainerInfo,
  Containers,
  ImageInfo,
} from "../environments/containers";
import { BASE_PROJECT_LABEL } from "../environments/images";
import { BusyError } from "../errors";
import type { RawSession } from "../opencode/client";
import type { StateStore } from "../projects/state";
import { rollUp, rootOf } from "../sessions/status";
import type { CleanupTargets } from "./cleanup-targets";
import type { BranchRef, GitOps } from "./ops";
import { InvalidRequestError } from "./worktrees";

/** A task environment may be starting from an image this new, before its record names it. */
export const FRESH_IMAGE_MS = 15 * 60_000;
const BASE_REPO = "opendevhub/";

export interface StaleDockerInput {
  /** Every container opendevhub labels (`Containers.listManaged`). */
  containers: ContainerInfo[];
  images: ImageInfo[];
  /** Current projects. */
  projects: Set<ProjectId>;
  hasEnv: (id: EnvId) => boolean;
  /** Base image refs the current projects' environment records were started from. */
  recordedRefs: Set<string>;
  now: number;
}

const staleContainer = (
  c: ContainerInfo,
  input: StaleDockerInput
): ContainerCleanupItem | undefined => {
  let why: ContainerCleanupItem["why"] | undefined;
  const projectId = c.envProjectId ?? c.projectId;
  if (c.envId && !input.hasEnv(c.envId)) {
    why = "orphan-env";
  } else if (projectId && !input.projects.has(projectId)) {
    why = "removed-project";
  }
  if (!why) {
    return undefined;
  }
  return {
    id: `container:${c.id}`,
    kind: "container",
    checked: !c.running,
    reason:
      why === "orphan-env"
        ? "opendevhub has no record of its worktree environment"
        : "its project is no longer configured",
    containerId: c.id,
    ...(c.name ? { name: c.name } : {}),
    running: c.running,
    why,
    ...(projectId ? { projectId } : {}),
  };
};

const staleImage = (
  img: ImageInfo,
  input: StaleDockerInput,
  used: Set<string>
): ImageCleanupItem | undefined => {
  if (
    img.refs.length === 0 ||
    used.has(img.id) ||
    input.now - img.created < FRESH_IMAGE_MS
  ) {
    return undefined;
  }
  const base = img.refs.find((r) => r.startsWith(BASE_REPO));
  let why: ImageCleanupItem["why"] | undefined;
  let projectId: string | undefined;
  if (base) {
    [projectId] = base.slice(BASE_REPO.length).split(":");
    if (!input.projects.has(projectId)) {
      why = "removed-project";
    } else if (
      base.endsWith("-base") &&
      !img.refs.some((r) => input.recordedRefs.has(r))
    ) {
      why = "superseded";
    }
  } else if (img.labels[BASE_PROJECT_LABEL]) {
    projectId = img.labels[BASE_PROJECT_LABEL];
    why = "uid";
  }
  if (!why) {
    return undefined;
  }
  const ref = base ?? img.refs[0];
  const reasons = {
    "removed-project": "its project is no longer configured",
    superseded: "no environment uses it",
    uid: "left behind by a removed task container",
  } as const;
  return {
    bytes: img.bytes,
    checked: true,
    id: `image:${ref}`,
    kind: "image",
    reason: reasons[why],
    ref,
    why,
    ...(projectId ? { projectId } : {}),
  };
};

/** Containers and images nothing current needs. An image only stale containers run counts as unused, so one apply frees both. */
export const staleDocker = (
  input: StaleDockerInput
): (ContainerCleanupItem | ImageCleanupItem)[] => {
  const containers = input.containers.flatMap(
    (c) => staleContainer(c, input) ?? []
  );
  const doomed = new Set(containers.map((c) => c.containerId));
  const used = new Set(
    input.containers.flatMap((c) =>
      !doomed.has(c.id) && c.imageId ? [c.imageId] : []
    )
  );
  return [
    ...containers,
    ...input.images.flatMap((img) => staleImage(img, input, used) ?? []),
  ];
};

export type BranchGit = Pick<
  GitOps,
  | "remotes"
  | "fetchPrune"
  | "branchRefs"
  | "remoteHead"
  | "isAncestor"
  | "recordedBase"
  | "currentBranch"
  | "isClean"
>;

export interface BranchScanInput {
  project: Project;
  /** The main checkout, as the container sees it. */
  workspace: string;
  /** Linked worktrees, from `git worktree list`. */
  worktrees: Worktree[];
  /** The task environment serving a worktree, if it has its own container. */
  envOf: (worktreePath: string) => EnvId | undefined;
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** The remote cleanup fetches from (`origin`, else the first) and the main checkout's branch. */
const repoContext = async (git: BranchGit, p: Project, ws: string) => {
  const remotes = await git.remotes(p, ws);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  return { current: await git.currentBranch(p, ws), remote };
};

/** The branch's recorded base, else the remote's HEAD branch, else the main checkout's branch. */
const baseOf = async (
  git: BranchGit,
  p: Project,
  ws: string,
  branch: string,
  ctx: { remote?: string; current?: string }
) => {
  const recorded = await git.recordedBase(p, ws, branch);
  if (recorded) {
    return recorded;
  }
  return (
    (ctx.remote && (await git.remoteHead(p, ws, ctx.remote))) || ctx.current
  );
};

/** Merged into its base, or pushed once and deleted on the remote since. Throws when git can't compare. */
const verdict = async (
  git: BranchGit,
  p: Project,
  ws: string,
  ref: BranchRef,
  base: string
) => {
  if (await git.isAncestor(p, ws, ref.name, base)) {
    return "merged" as const;
  }
  if (ref.upstream && ref.gone) {
    return "upstream-gone" as const;
  }
  return undefined;
};

/** Local branches that may go, with their worktrees. Fetches first; a failed fetch leaves a warning and local refs. */
export const scanBranches = async (
  git: BranchGit,
  input: BranchScanInput
): Promise<{ warning?: string; items: BranchCleanupItem[] }> => {
  const { project: p, workspace: ws } = input;
  const ctx = await repoContext(git, p, ws);
  let warning: string | undefined;
  if (ctx.remote) {
    try {
      await git.fetchPrune(p, ws, ctx.remote);
    } catch (error) {
      warning = `using local refs: ${message(error)}`;
    }
  }
  const items: BranchCleanupItem[] = [];
  for (const ref of await git.branchRefs(p, ws)) {
    if (ref.name === ctx.current) {
      continue;
    }
    const base = await baseOf(git, p, ws, ref.name, ctx);
    if (!base || base === ref.name || base.startsWith("-")) {
      continue;
    }
    const why = await verdict(git, p, ws, ref, base).catch(() => undefined);
    if (!why) {
      continue;
    }
    const worktree = input.worktrees.find((w) => w.branch === ref.name);
    // A worktree whose status can't be read counts as dirty, so it's never removed by default.
    const dirty = worktree
      ? !(await git.isClean(p, worktree.path).catch(() => false))
      : false;
    const env = worktree && input.envOf(worktree.path);
    items.push({
      base,
      branch: ref.name,
      checked: why === "merged" && !dirty,
      id: `branch:${p.id}:${ref.name}`,
      kind: "branch",
      projectId: p.id,
      reason:
        why === "merged"
          ? `merged into ${base}`
          : "its upstream is gone; it may not be merged",
      why,
      ...(worktree ? { worktree: worktree.path } : {}),
      ...(dirty ? { dirty: true } : {}),
      ...(env ? { env } : {}),
    });
  }
  return { ...(warning ? { warning } : {}), items };
};

/**
 * Why a scanned branch must not be removed now, or undefined when it still qualifies. Recomputes the base and the
 * verdict rather than trusting the item; no fetch, so it judges the refs the scan left.
 */
export const branchChanged = async (
  git: BranchGit,
  p: Project,
  ws: string,
  item: BranchCleanupItem,
  worktrees: Worktree[]
): Promise<string | undefined> => {
  const result = await git.branchRefs(p, ws);
  const ref = result.find((r) => r.name === item.branch);
  if (!ref) {
    return "the branch no longer exists";
  }
  const ctx = await repoContext(git, p, ws);
  if (ref.name === ctx.current) {
    return "the branch is checked out in the main checkout";
  }
  const base = await baseOf(git, p, ws, ref.name, ctx);
  const why =
    base && base !== ref.name
      ? await verdict(git, p, ws, ref, base).catch(() => undefined)
      : undefined;
  if (!why || (item.why === "merged" && why !== "merged")) {
    return "changed since scan";
  }
  const worktree = worktrees.find((w) => w.branch === item.branch);
  if (worktree?.path !== item.worktree) {
    return "changed since scan";
  }
  if (
    worktree &&
    !item.dirty &&
    !(await git.isClean(p, worktree.path).catch(() => false))
  ) {
    return "changed since scan: the worktree has uncommitted changes";
  }
  return undefined;
};

/** A session untouched this long is offered for removal, unchecked. */
export const IDLE_SESSION_MS = 30 * 24 * 60 * 60_000;

export interface StaleSessionsInput {
  projectId: ProjectId;
  /** The task environment whose opencode listed the sessions; absent for the main environment. */
  envId?: EnvId;
  /** Every session that opencode lists, subagents included. */
  sessions: RawSession[];
  /** Sessions running or waiting on a permission or an answer, at any depth. */
  busy: Set<string>;
  /** The main checkout, as the container sees it. */
  workspace: string;
  /** Current linked worktree paths; unknown means no session counts as of a removed worktree. */
  worktrees?: string[];
  /** Whether a session's task variant was discarded, from the variant's row. */
  discarded?: (sessionId: string) => boolean;
  now: number;
}

const within = (dir: string, root: string) =>
  dir === root || dir.startsWith(`${root.replace(/\/$/u, "")}/`);

/** Top-level sessions that may go: discarded task variants, sessions of removed worktrees, and long-idle ones. */
export const staleSessions = (
  input: StaleSessionsInput
): SessionCleanupItem[] => {
  const parents = new Map(input.sessions.map((s) => [s.id, s.parentID]));
  const busy = new Set([...input.busy].map((id) => rootOf(id, parents)));
  const trees = rollUp(input.sessions);
  const items: SessionCleanupItem[] = [];
  for (const s of input.sessions) {
    if (s.parentID || s.time.archived !== undefined || busy.has(s.id)) {
      continue;
    }
    const { directory } = s.location;
    const updatedAt = trees.get(s.id)?.updatedAt ?? s.time.updated;
    const idleDays = Math.floor((input.now - updatedAt) / (24 * 60 * 60_000));
    let why;
    if (input.discarded?.(s.id)) {
      why = "discarded" as const;
    } else if (
      input.worktrees &&
      !within(directory, input.workspace) &&
      !input.worktrees.some((w) => within(directory, w))
    ) {
      why = "worktree-gone" as const;
    } else if (input.now - updatedAt >= IDLE_SESSION_MS) {
      why = "idle" as const;
    } else {
      why = undefined;
    }
    if (!why) {
      continue;
    }
    const reasons = {
      discarded: "discarded task variant",
      idle: `idle for ${idleDays} days`,
      "worktree-gone": "its worktree was removed",
    };
    items.push({
      id: `session:${input.projectId}:${s.id}`,
      kind: "session",
      checked: why !== "idle",
      reason: reasons[why],
      projectId: input.projectId,
      ...(input.envId ? { envId: input.envId } : {}),
      sessionId: s.id,
      title: s.title?.trim() || "Untitled session",
      directory,
      updatedAt,
      why,
    });
  }
  return items;
};

/** Ended tasks nothing has happened to for as long as an idle session, offered for archiving. */
export const staleTasks = (
  projectId: ProjectId,
  tasks: Pick<TaskStore, "listForProject" | "lastActivity">,
  now: number
): TaskCleanupItem[] =>
  tasks.listForProject(projectId).flatMap((t) => {
    const last = tasks.lastActivity(t.id) ?? t.createdAt;
    if (t.state !== "ended" || now - last < IDLE_SESSION_MS) {
      return [];
    }
    const days = Math.floor((now - last) / (24 * 60 * 60_000));
    return [
      {
        checked: true,
        id: `task:${projectId}:${t.id}`,
        kind: "task" as const,
        lastActivity: last,
        projectId,
        reason: `ended, nothing happened for ${days} days`,
        taskId: t.id,
        title: t.title,
      },
    ];
  });

/** opendevhub's base images by name, and the UID images built on them by label. */
export const CLEANUP_IMAGE_FILTERS = [
  `reference=${BASE_REPO}*`,
  `label=${BASE_PROJECT_LABEL}`,
];

export interface CleanupDeps {
  store: Pick<
    StateStore,
    "projects" | "project" | "runtime" | "environments" | "environment"
  >;
  containers: Pick<
    Containers,
    "listManaged" | "listImages" | "remove" | "removeImage"
  >;
  branches: Pick<
    CleanupTargets,
    "cleanupScan" | "cleanupBranch" | "cleanupSessionScan" | "cleanupSession"
  >;
  /** Ended tasks to offer for archiving; none are offered without it. */
  tasks?: Pick<
    TaskStore,
    "listForProject" | "lastActivity" | "get" | "archive"
  >;
  /** Writes a line to a project's log. */
  log: (projectId: ProjectId, line: string) => void;
  now?: () => number;
}

type DockerItem = ContainerCleanupItem | ImageCleanupItem;

export class Cleanup {
  private applying = false;

  private readonly deps: CleanupDeps;
  constructor(deps: CleanupDeps) {
    this.deps = deps;
  }

  async scan(): Promise<CleanupPlan> {
    const scannedAt = this.now();
    const [perProject, docker] = await Promise.all([
      Promise.all(this.deps.store.projects().map((p) => this.scanProject(p))),
      this.docker().then(
        (items) => ({ error: undefined, items }),
        (error: unknown) => ({
          error: message(error),
          items: [] as DockerItem[],
        })
      ),
    ]);
    return {
      scannedAt,
      projects: perProject.map((r) => r.summary),
      ...(docker.error ? { dockerError: docker.error } : {}),
      items: [...perProject.flatMap((r) => r.items), ...docker.items],
    };
  }

  /**
   * Removes the selected items: branches, then sessions, then containers, then images, each re-checked first. Tasks
   * are archived last.
   */
  async apply(items: CleanupItem[]): Promise<CleanupResult> {
    if (this.applying) {
      throw new BusyError("cleanup");
    }
    this.applying = true;
    try {
      const results: CleanupResult["results"] = [];
      let freedBytes = 0;
      for (const item of items) {
        if (item.kind === "branch") {
          results.push({ id: item.id, ...(await this.removeBranch(item)) });
        }
      }
      for (const item of items) {
        if (item.kind === "session") {
          results.push({ id: item.id, ...(await this.removeSession(item)) });
        }
      }
      for (const kind of ["container", "image"] as const) {
        const selected = items.filter((i) => i.kind === kind);
        if (selected.length === 0) {
          continue;
        }
        // Scanned again per kind, since removing containers frees their images. Only an item the fresh scan lists is
        // removed, and the fresh item (not the request's) supplies the reason, owner and size.
        let fresh: Map<string, DockerItem>;
        try {
          const scanned = await this.docker();
          fresh = new Map(scanned.map((i) => [i.id, i]));
        } catch (error) {
          for (const item of selected) {
            results.push({
              id: item.id,
              message: message(error),
              outcome: "failed",
            });
          }
          continue;
        }
        for (const item of selected) {
          const current = fresh.get(item.id);
          const outcome = current
            ? await this.removeDocker(current)
            : {
                message: "in use, or already gone",
                outcome: "skipped" as const,
              };
          if (current?.kind === "image" && outcome.outcome === "removed") {
            freedBytes += current.bytes;
          }
          results.push({ id: item.id, ...outcome });
        }
      }
      for (const item of items) {
        if (item.kind === "task") {
          results.push({ id: item.id, ...this.archiveTask(item) });
        }
      }
      return { freedBytes, results };
    } finally {
      this.applying = false;
    }
  }

  private async scanProject(
    p: Project
  ): Promise<{ summary: CleanupProject; items: CleanupItem[] }> {
    const summary: CleanupProject = { id: p.id, name: p.name };
    // Tasks live in the database, so they are offered whether or not the container runs.
    const items: CleanupItem[] = this.deps.tasks
      ? staleTasks(p.id, this.deps.tasks, this.now())
      : [];
    if (this.deps.store.runtime(p.id).containerState !== "running") {
      return { items, summary: { ...summary, skipped: "not running" } };
    }
    const warnings: string[] = [];
    try {
      const r = await this.deps.branches.cleanupScan(p.id);
      if (r.warning) {
        warnings.push(r.warning);
      }
      items.push(...r.items);
    } catch (error) {
      warnings.push(
        error instanceof BusyError
          ? "busy with another git action; scan again in a moment"
          : `could not scan branches: ${message(error)}`
      );
    }
    // After the branch scan, which refreshes the worktree list that tells a removed worktree's sessions apart.
    try {
      const r = await this.deps.branches.cleanupSessionScan(p.id);
      if (r.warning) {
        warnings.push(r.warning);
      }
      items.push(...r.items);
    } catch (error) {
      warnings.push(`could not scan sessions: ${message(error)}`);
    }
    return {
      items,
      summary: {
        ...summary,
        ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
      },
    };
  }

  private async docker(): Promise<DockerItem[]> {
    const { store, containers } = this.deps;
    const [list, images] = await Promise.all([
      containers.listManaged(),
      containers.listImages(CLEANUP_IMAGE_FILTERS),
    ]);
    const projects = store.projects();
    const recordedRefs = new Set(
      projects
        .flatMap((p) => store.environments(p.id))
        .flatMap((e) => (e.image ? [e.image.ref] : []))
    );
    return staleDocker({
      containers: list,
      hasEnv: (id) => store.environment(id) !== undefined,
      images,
      now: this.now(),
      projects: new Set(projects.map((p) => p.id)),
      recordedRefs,
    });
  }

  private async removeBranch(item: BranchCleanupItem): Promise<CleanupOutcome> {
    try {
      return await this.deps.branches.cleanupBranch(item.projectId, item);
    } catch (error) {
      if (error instanceof BusyError) {
        return { message: "project busy", outcome: "skipped" };
      }
      if (this.deps.store.project(item.projectId)) {
        this.deps.log(
          item.projectId,
          `cleanup: could not delete branch ${item.branch}: ${message(error)}`
        );
      }
      return { message: message(error), outcome: "failed" };
    }
  }

  private async removeSession(
    item: SessionCleanupItem
  ): Promise<CleanupOutcome> {
    try {
      return await this.deps.branches.cleanupSession(item.projectId, item);
    } catch (error) {
      if (this.deps.store.project(item.projectId)) {
        this.deps.log(
          item.projectId,
          `cleanup: could not remove session ${item.sessionId}: ${message(error)}`
        );
      }
      return { message: message(error), outcome: "failed" };
    }
  }

  /** Archives a scanned task, if it is still ended and not archived. */
  private archiveTask(item: TaskCleanupItem): CleanupOutcome {
    const task = this.deps.tasks?.get(item.taskId);
    if (
      !task ||
      task.projectId !== item.projectId ||
      task.archivedAt !== undefined ||
      task.state !== "ended"
    ) {
      return { message: "no longer an ended task", outcome: "skipped" };
    }
    try {
      this.deps.tasks?.archive(item.taskId, USER);
      this.deps.log(item.projectId, `cleanup: archived task ${task.title}`);
      return { message: "archived", outcome: "removed" };
    } catch (error) {
      return { message: message(error), outcome: "failed" };
    }
  }

  private async removeDocker(item: DockerItem): Promise<CleanupOutcome> {
    const what =
      item.kind === "container"
        ? `container ${item.name ?? item.containerId}`
        : `image ${item.ref}`;
    const log = (line: string) => {
      if (item.projectId && this.deps.store.project(item.projectId)) {
        this.deps.log(item.projectId, line);
      }
    };
    try {
      if (item.kind === "container") {
        await this.deps.containers.remove(item.containerId);
      } else if (!(await this.deps.containers.removeImage(item.ref))) {
        return { message: "in use, or already gone", outcome: "skipped" };
      }
      log(`cleanup: removed ${what} (${item.reason})`);
      return { outcome: "removed" };
    } catch (error) {
      log(`cleanup: could not remove ${what}: ${message(error)}`);
      return { message: message(error), outcome: "failed" };
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

const field = (o: Record<string, unknown>, key: string): string => {
  const v = o[key];
  if (typeof v !== "string" || v === "" || v.startsWith("-")) {
    throw new InvalidRequestError(`cleanup item needs a valid ${key}`);
  }
  return v;
};

/**
 * The selected items of `POST /api/cleanup`. Only kind and identity matter: apply re-derives everything else from
 * fresh state, so a forged reason or verdict changes nothing.
 */
export const parseCleanupItems = (value: unknown): CleanupItem[] => {
  if (!Array.isArray(value)) {
    throw new InvalidRequestError("items must be a list");
  }
  return value.map((raw): CleanupItem => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    if (o.kind === "branch") {
      const projectId = field(o, "projectId");
      const branch = field(o, "branch");
      if (o.why !== "merged" && o.why !== "upstream-gone") {
        throw new InvalidRequestError("cleanup item needs a valid why");
      }
      const worktree = typeof o.worktree === "string" ? o.worktree : undefined;
      return {
        base: typeof o.base === "string" ? o.base : "",
        branch,
        checked: true,
        id: `branch:${projectId}:${branch}`,
        kind: "branch",
        projectId,
        reason: typeof o.reason === "string" ? o.reason : "",
        why: o.why,
        ...(worktree ? { worktree } : {}),
        ...(o.dirty === true ? { dirty: true } : {}),
      };
    }
    if (o.kind === "container") {
      const containerId = field(o, "containerId");
      return {
        checked: true,
        containerId,
        id: `container:${containerId}`,
        kind: "container",
        reason: "",
        running: false,
        why: "orphan-env",
      };
    }
    if (o.kind === "image") {
      const ref = field(o, "ref");
      return {
        bytes: 0,
        checked: true,
        id: `image:${ref}`,
        kind: "image",
        reason: "",
        ref,
        why: "superseded",
      };
    }
    if (o.kind === "session") {
      const projectId = field(o, "projectId");
      const sessionId = field(o, "sessionId");
      const envId =
        typeof o.envId === "string" && o.envId !== "" ? o.envId : undefined;
      return {
        id: `session:${projectId}:${sessionId}`,
        kind: "session",
        checked: true,
        reason: "",
        projectId,
        ...(envId ? { envId } : {}),
        sessionId,
        title: "",
        directory: "",
        updatedAt: 0,
        why: "idle",
      };
    }
    if (o.kind === "task") {
      const projectId = field(o, "projectId");
      const taskId = field(o, "taskId");
      return {
        checked: true,
        id: `task:${projectId}:${taskId}`,
        kind: "task",
        lastActivity: 0,
        projectId,
        reason: "",
        taskId,
        title: "",
      };
    }
    throw new InvalidRequestError(
      `unknown cleanup item kind ${String(o.kind)}`
    );
  });
};
