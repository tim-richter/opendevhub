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
  Worktree,
} from "../shared/types";
import type { ContainerInfo, Containers, ImageInfo } from "./containers";
import type { BranchRef, GitOps } from "./git";
import { BusyError, type Orchestrator } from "./orchestrator";
import type { StateStore } from "./state";
import { InvalidRequestError } from "./worktrees";
import { BASE_PROJECT_LABEL } from "./images";
import type { RawSession } from "./opencode/client";
import { rollUp, rootOf } from "./status";
import { parseTaskMeta } from "./tasks";

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

function staleContainer(c: ContainerInfo, input: StaleDockerInput): ContainerCleanupItem | undefined {
  let why: ContainerCleanupItem["why"] | undefined;
  const projectId = c.envProjectId ?? c.projectId;
  if (c.envId && !input.hasEnv(c.envId)) why = "orphan-env";
  else if (projectId && !input.projects.has(projectId)) why = "removed-project";
  if (!why) return undefined;
  return {
    id: `container:${c.id}`,
    kind: "container",
    checked: !c.running,
    reason: why === "orphan-env" ? "opendevhub has no record of its worktree environment" : "its project is no longer configured",
    containerId: c.id,
    ...(c.name ? { name: c.name } : {}),
    running: c.running,
    why,
    ...(projectId ? { projectId } : {}),
  };
}

function staleImage(img: ImageInfo, input: StaleDockerInput, used: Set<string>): ImageCleanupItem | undefined {
  if (img.refs.length === 0 || used.has(img.id) || input.now - img.created < FRESH_IMAGE_MS) return undefined;
  const base = img.refs.find((r) => r.startsWith(BASE_REPO));
  let why: ImageCleanupItem["why"] | undefined;
  let projectId: string | undefined;
  if (base) {
    projectId = base.slice(BASE_REPO.length).split(":")[0];
    if (!input.projects.has(projectId)) why = "removed-project";
    else if (base.endsWith("-base") && !img.refs.some((r) => input.recordedRefs.has(r))) why = "superseded";
  } else if (img.labels[BASE_PROJECT_LABEL]) {
    projectId = img.labels[BASE_PROJECT_LABEL];
    why = "uid";
  }
  if (!why) return undefined;
  const ref = base ?? img.refs[0];
  const reasons = {
    superseded: "no environment uses it",
    "removed-project": "its project is no longer configured",
    uid: "left behind by a removed task container",
  } as const;
  return { id: `image:${ref}`, kind: "image", checked: true, reason: reasons[why], ref, bytes: img.bytes, why, ...(projectId ? { projectId } : {}) };
}

/** Containers and images nothing current needs. An image only stale containers run counts as unused, so one apply frees both. */
export function staleDocker(input: StaleDockerInput): (ContainerCleanupItem | ImageCleanupItem)[] {
  const containers = input.containers.flatMap((c) => staleContainer(c, input) ?? []);
  const doomed = new Set(containers.map((c) => c.containerId));
  const used = new Set(input.containers.filter((c) => !doomed.has(c.id) && c.imageId).map((c) => c.imageId!));
  return [...containers, ...input.images.flatMap((img) => staleImage(img, input, used) ?? [])];
}

export type BranchGit = Pick<
  GitOps,
  "remotes" | "fetchPrune" | "branchRefs" | "remoteHead" | "isAncestor" | "recordedBase" | "currentBranch" | "isClean"
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The remote cleanup fetches from (`origin`, else the first) and the main checkout's branch. */
async function repoContext(git: BranchGit, p: Project, ws: string) {
  const remotes = await git.remotes(p, ws);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  return { remote, current: await git.currentBranch(p, ws) };
}

/** The branch's recorded base, else the remote's HEAD branch, else the main checkout's branch. */
async function baseOf(git: BranchGit, p: Project, ws: string, branch: string, ctx: { remote?: string; current?: string }) {
  const recorded = await git.recordedBase(p, ws, branch);
  if (recorded) return recorded;
  return (ctx.remote && (await git.remoteHead(p, ws, ctx.remote))) || ctx.current;
}

/** Merged into its base, or pushed once and deleted on the remote since. Throws when git can't compare. */
async function verdict(git: BranchGit, p: Project, ws: string, ref: BranchRef, base: string) {
  if (await git.isAncestor(p, ws, ref.name, base)) return "merged" as const;
  if (ref.upstream && ref.gone) return "upstream-gone" as const;
  return undefined;
}

/** Local branches that may go, with their worktrees. Fetches first; a failed fetch leaves a warning and local refs. */
export async function scanBranches(git: BranchGit, input: BranchScanInput): Promise<{ warning?: string; items: BranchCleanupItem[] }> {
  const { project: p, workspace: ws } = input;
  const ctx = await repoContext(git, p, ws);
  let warning: string | undefined;
  if (ctx.remote) {
    try {
      await git.fetchPrune(p, ws, ctx.remote);
    } catch (err) {
      warning = `using local refs: ${message(err)}`;
    }
  }
  const items: BranchCleanupItem[] = [];
  for (const ref of await git.branchRefs(p, ws)) {
    if (ref.name === ctx.current) continue;
    const base = await baseOf(git, p, ws, ref.name, ctx);
    if (!base || base === ref.name || base.startsWith("-")) continue;
    const why = await verdict(git, p, ws, ref, base).catch(() => undefined);
    if (!why) continue;
    const worktree = input.worktrees.find((w) => w.branch === ref.name);
    // A worktree whose status can't be read counts as dirty, so it's never removed by default.
    const dirty = worktree ? !(await git.isClean(p, worktree.path).catch(() => false)) : false;
    const env = worktree && input.envOf(worktree.path);
    items.push({
      id: `branch:${p.id}:${ref.name}`,
      kind: "branch",
      checked: why === "merged" && !dirty,
      reason: why === "merged" ? `merged into ${base}` : "its upstream is gone; it may not be merged",
      projectId: p.id,
      branch: ref.name,
      base,
      why,
      ...(worktree ? { worktree: worktree.path } : {}),
      ...(dirty ? { dirty: true } : {}),
      ...(env ? { env } : {}),
    });
  }
  return { ...(warning ? { warning } : {}), items };
}

/**
 * Why a scanned branch must not be removed now, or undefined when it still qualifies. Recomputes the base and the
 * verdict rather than trusting the item; no fetch, so it judges the refs the scan left.
 */
export async function branchChanged(
  git: BranchGit,
  p: Project,
  ws: string,
  item: BranchCleanupItem,
  worktrees: Worktree[],
): Promise<string | undefined> {
  const ref = (await git.branchRefs(p, ws)).find((r) => r.name === item.branch);
  if (!ref) return "the branch no longer exists";
  const ctx = await repoContext(git, p, ws);
  if (ref.name === ctx.current) return "the branch is checked out in the main checkout";
  const base = await baseOf(git, p, ws, ref.name, ctx);
  const why = base && base !== ref.name ? await verdict(git, p, ws, ref, base).catch(() => undefined) : undefined;
  if (!why || (item.why === "merged" && why !== "merged")) return "changed since scan";
  const worktree = worktrees.find((w) => w.branch === item.branch);
  if (worktree?.path !== item.worktree) return "changed since scan";
  if (worktree && !item.dirty && !(await git.isClean(p, worktree.path).catch(() => false))) {
    return "changed since scan: the worktree has uncommitted changes";
  }
  return undefined;
}

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
  now: number;
}

const within = (dir: string, root: string) => dir === root || dir.startsWith(root.replace(/\/$/, "") + "/");

/** Top-level sessions that may go: discarded task variants, sessions of removed worktrees, and long-idle ones. */
export function staleSessions(input: StaleSessionsInput): SessionCleanupItem[] {
  const parents = new Map(input.sessions.map((s) => [s.id, s.parentID]));
  const busy = new Set([...input.busy].map((id) => rootOf(id, parents)));
  const trees = rollUp(input.sessions);
  const items: SessionCleanupItem[] = [];
  for (const s of input.sessions) {
    if (s.parentID || s.time.archived !== undefined || busy.has(s.id)) continue;
    const directory = s.location.directory;
    const updatedAt = trees.get(s.id)?.updatedAt ?? s.time.updated;
    const idleDays = Math.floor((input.now - updatedAt) / (24 * 60 * 60_000));
    const why = parseTaskMeta(s.metadata)?.discarded
      ? ("discarded" as const)
      : input.worktrees && !within(directory, input.workspace) && !input.worktrees.some((w) => within(directory, w))
        ? ("worktree-gone" as const)
        : input.now - updatedAt >= IDLE_SESSION_MS
          ? ("idle" as const)
          : undefined;
    if (!why) continue;
    const reasons = { discarded: "discarded task variant", "worktree-gone": "its worktree was removed", idle: `idle for ${idleDays} days` };
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
}

/** opendevhub's base images by name, and the UID images built on them by label. */
export const CLEANUP_IMAGE_FILTERS = [`reference=${BASE_REPO}*`, `label=${BASE_PROJECT_LABEL}`];

export interface CleanupDeps {
  store: Pick<StateStore, "projects" | "project" | "runtime" | "environments" | "environment">;
  containers: Pick<Containers, "listManaged" | "listImages" | "remove" | "removeImage">;
  branches: Pick<Orchestrator, "cleanupScan" | "cleanupBranch" | "cleanupSessionScan" | "cleanupSession" | "appendLog">;
  now?: () => number;
}

type DockerItem = ContainerCleanupItem | ImageCleanupItem;

export class Cleanup {
  private applying = false;

  constructor(private readonly deps: CleanupDeps) {}

  async scan(): Promise<CleanupPlan> {
    const scannedAt = this.now();
    const [perProject, docker] = await Promise.all([
      Promise.all(this.deps.store.projects().map((p) => this.scanProject(p))),
      this.docker().then(
        (items) => ({ items, error: undefined }),
        (err: unknown) => ({ items: [] as DockerItem[], error: message(err) }),
      ),
    ]);
    return {
      scannedAt,
      projects: perProject.map((r) => r.summary),
      ...(docker.error ? { dockerError: docker.error } : {}),
      items: [...perProject.flatMap((r) => r.items), ...docker.items],
    };
  }

  /** Removes the selected items: branches, then sessions, then containers, then images, each re-checked first. */
  async apply(items: CleanupItem[]): Promise<CleanupResult> {
    if (this.applying) throw new BusyError("cleanup");
    this.applying = true;
    try {
      const results: CleanupResult["results"] = [];
      let freedBytes = 0;
      for (const item of items) if (item.kind === "branch") results.push({ id: item.id, ...(await this.removeBranch(item)) });
      for (const item of items) if (item.kind === "session") results.push({ id: item.id, ...(await this.removeSession(item)) });
      for (const kind of ["container", "image"] as const) {
        const selected = items.filter((i) => i.kind === kind);
        if (selected.length === 0) continue;
        // Scanned again per kind, since removing containers frees their images. Only an item the fresh scan lists is
        // removed, and the fresh item (not the request's) supplies the reason, owner and size.
        let fresh: Map<string, DockerItem>;
        try {
          fresh = new Map((await this.docker()).map((i) => [i.id, i]));
        } catch (err) {
          for (const item of selected) results.push({ id: item.id, outcome: "failed", message: message(err) });
          continue;
        }
        for (const item of selected) {
          const current = fresh.get(item.id);
          const outcome = current ? await this.removeDocker(current) : { outcome: "skipped" as const, message: "in use, or already gone" };
          if (current?.kind === "image" && outcome.outcome === "removed") freedBytes += current.bytes;
          results.push({ id: item.id, ...outcome });
        }
      }
      return { results, freedBytes };
    } finally {
      this.applying = false;
    }
  }

  private async scanProject(p: Project): Promise<{ summary: CleanupProject; items: CleanupItem[] }> {
    const summary: CleanupProject = { id: p.id, name: p.name };
    if (this.deps.store.runtime(p.id).containerState !== "running") return { summary: { ...summary, skipped: "not running" }, items: [] };
    const warnings: string[] = [];
    const items: CleanupItem[] = [];
    try {
      const r = await this.deps.branches.cleanupScan(p.id);
      if (r.warning) warnings.push(r.warning);
      items.push(...r.items);
    } catch (err) {
      warnings.push(err instanceof BusyError ? "busy with another git action; scan again in a moment" : `could not scan branches: ${message(err)}`);
    }
    // After the branch scan, which refreshes the worktree list that tells a removed worktree's sessions apart.
    try {
      const r = await this.deps.branches.cleanupSessionScan(p.id);
      if (r.warning) warnings.push(r.warning);
      items.push(...r.items);
    } catch (err) {
      warnings.push(`could not scan sessions: ${message(err)}`);
    }
    return { summary: { ...summary, ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}) }, items };
  }

  private async docker(): Promise<DockerItem[]> {
    const { store, containers } = this.deps;
    const [list, images] = await Promise.all([containers.listManaged(), containers.listImages(CLEANUP_IMAGE_FILTERS)]);
    const projects = store.projects();
    const recordedRefs = new Set(projects.flatMap((p) => store.environments(p.id)).flatMap((e) => (e.image ? [e.image.ref] : [])));
    return staleDocker({
      containers: list,
      images,
      projects: new Set(projects.map((p) => p.id)),
      hasEnv: (id) => store.environment(id) !== undefined,
      recordedRefs,
      now: this.now(),
    });
  }

  private async removeBranch(item: BranchCleanupItem): Promise<CleanupOutcome> {
    try {
      return await this.deps.branches.cleanupBranch(item.projectId, item);
    } catch (err) {
      if (err instanceof BusyError) return { outcome: "skipped", message: "project busy" };
      if (this.deps.store.project(item.projectId)) {
        this.deps.branches.appendLog(item.projectId, `cleanup: could not delete branch ${item.branch}: ${message(err)}`);
      }
      return { outcome: "failed", message: message(err) };
    }
  }

  private async removeSession(item: SessionCleanupItem): Promise<CleanupOutcome> {
    try {
      return await this.deps.branches.cleanupSession(item.projectId, item);
    } catch (err) {
      if (this.deps.store.project(item.projectId)) {
        this.deps.branches.appendLog(item.projectId, `cleanup: could not remove session ${item.sessionId}: ${message(err)}`);
      }
      return { outcome: "failed", message: message(err) };
    }
  }

  private async removeDocker(item: DockerItem): Promise<CleanupOutcome> {
    const what = item.kind === "container" ? `container ${item.name ?? item.containerId}` : `image ${item.ref}`;
    const log = (line: string) => {
      if (item.projectId && this.deps.store.project(item.projectId)) this.deps.branches.appendLog(item.projectId, line);
    };
    try {
      if (item.kind === "container") {
        await this.deps.containers.remove(item.containerId);
      } else if (!(await this.deps.containers.removeImage(item.ref))) {
        return { outcome: "skipped", message: "in use, or already gone" };
      }
      log(`cleanup: removed ${what} (${item.reason})`);
      return { outcome: "removed" };
    } catch (err) {
      log(`cleanup: could not remove ${what}: ${message(err)}`);
      return { outcome: "failed", message: message(err) };
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function field(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v === "" || v.startsWith("-")) throw new InvalidRequestError(`cleanup item needs a valid ${key}`);
  return v;
}

/**
 * The selected items of `POST /api/cleanup`. Only kind and identity matter: apply re-derives everything else from
 * fresh state, so a forged reason or verdict changes nothing.
 */
export function parseCleanupItems(value: unknown): CleanupItem[] {
  if (!Array.isArray(value)) throw new InvalidRequestError("items must be a list");
  return value.map((raw): CleanupItem => {
    const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    if (o.kind === "branch") {
      const projectId = field(o, "projectId");
      const branch = field(o, "branch");
      if (o.why !== "merged" && o.why !== "upstream-gone") throw new InvalidRequestError("cleanup item needs a valid why");
      const worktree = typeof o.worktree === "string" ? o.worktree : undefined;
      return {
        id: `branch:${projectId}:${branch}`,
        kind: "branch",
        checked: true,
        reason: typeof o.reason === "string" ? o.reason : "",
        projectId,
        branch,
        base: typeof o.base === "string" ? o.base : "",
        why: o.why,
        ...(worktree ? { worktree } : {}),
        ...(o.dirty === true ? { dirty: true } : {}),
      };
    }
    if (o.kind === "container") {
      const containerId = field(o, "containerId");
      return { id: `container:${containerId}`, kind: "container", checked: true, reason: "", containerId, running: false, why: "orphan-env" };
    }
    if (o.kind === "image") {
      const ref = field(o, "ref");
      return { id: `image:${ref}`, kind: "image", checked: true, reason: "", ref, bytes: 0, why: "superseded" };
    }
    if (o.kind === "session") {
      const projectId = field(o, "projectId");
      const sessionId = field(o, "sessionId");
      const envId = typeof o.envId === "string" && o.envId !== "" ? o.envId : undefined;
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
    throw new InvalidRequestError(`unknown cleanup item kind ${String(o.kind)}`);
  });
}
