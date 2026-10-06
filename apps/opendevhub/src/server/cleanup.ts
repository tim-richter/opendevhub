import type { ContainerCleanupItem, EnvId, ImageCleanupItem, ProjectId } from "../shared/types";
import type { ContainerInfo, ImageInfo } from "./containers";
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
