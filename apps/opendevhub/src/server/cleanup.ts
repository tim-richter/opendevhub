import type { BranchCleanupItem, ContainerCleanupItem, EnvId, ImageCleanupItem, Project, ProjectId, Worktree } from "../shared/types";
import type { ContainerInfo, ImageInfo } from "./containers";
import type { BranchRef, GitOps } from "./git";
import { BASE_PROJECT_LABEL } from "./images";

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
