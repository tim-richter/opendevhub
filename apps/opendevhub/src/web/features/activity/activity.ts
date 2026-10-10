import type {
  ActivityEvent,
  ActivityFilter,
  Actor,
  EventVerb,
} from "../../../shared/activity";
import type { SessionTaskRef } from "../../../shared/types";
import { checkoutPath } from "../checkouts/checkouts";
import { forgejoRoute } from "../forgejo/forgejo";
import { taskPath } from "../tasks/tasks";

const PR_NUMBER = /\/(?:pulls|pull|merge_requests)\/(?<n>\d+)\/?$/u;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined;

const folderName = (path: string) => path.split("/").findLast(Boolean) ?? path;

/** "PR #12" from a pull request URL, else "a pull request". */
export const pullLabel = (url: string | undefined): string => {
  const n = url ? PR_NUMBER.exec(url)?.groups?.n : undefined;
  return n ? `PR #${n}` : "a pull request";
};

/** Who did it, at the start of a sentence. */
export const actorLabel = (actor: Actor): string => {
  if (actor.type === "user") {
    return "You";
  }
  if (actor.type === "system") {
    return "opendevhub";
  }
  return `Variant ${actor.id.split("/").at(-1) ?? ""}`;
};

const task = (e: ActivityEvent): string =>
  e.taskTitle ? `“${e.taskTitle}”` : "a task";

const variantN = (e: ActivityEvent): string =>
  e.object.type === "variant"
    ? (e.object.id.split("/").at(-1) ?? "")
    : String(num(e.data?.variant) ?? "");

const worktree = (e: ActivityEvent): string => {
  const path = str(e.data?.path);
  return path ? folderName(path) : "a worktree";
};

const branch = (e: ActivityEvent): string =>
  str(e.data?.name) ?? str(e.data?.branch) ?? "a branch";

const sessionOf = (e: ActivityEvent): string =>
  e.taskTitle ? `“${e.taskTitle}”` : "a session";

/**
 * One sentence per verb. Typed by `EventVerb`, so a verb added without a renderer fails to compile; the test suite
 * checks the same at runtime against `EVENT_VERBS`.
 */
export const EVENT_TEXT: Record<EventVerb, (e: ActivityEvent) => string> = {
  "branch.created": (e) =>
    e.data?.createdBy === "unmanaged"
      ? `opendevhub found branch ${branch(e)}, created outside opendevhub`
      : `${actorLabel(e.actor)} created branch ${branch(e)}`,
  "branch.deleted": (e) => `${actorLabel(e.actor)} deleted branch ${branch(e)}`,
  "branch.published": (e) => {
    const remote = str(e.data?.remote);
    return `${actorLabel(e.actor)} published branch ${branch(e)}${remote ? ` to ${remote}` : ""}`;
  },
  "environment.created": (e) =>
    `${actorLabel(e.actor)} created a container${e.taskTitle ? ` for ${task(e)}` : ""}`,
  "environment.removed": (e) =>
    `${actorLabel(e.actor)} removed a container${e.taskTitle ? ` of ${task(e)}` : ""}`,
  "project.discovered": (e) => {
    const name = str(e.data?.name) ?? e.projectName ?? "a project";
    return e.data?.returned === true
      ? `Project ${name} is back`
      : `opendevhub found project ${name}`;
  },
  "project.missing": (e) =>
    `Project ${str(e.data?.name) ?? e.projectName ?? ""} went missing`,
  "pull_request.linked": (e) => {
    const pr = pullLabel(str(e.data?.url));
    return e.data?.role === "checkout"
      ? `${actorLabel(e.actor)} checked out ${pr} on ${branch(e)}`
      : `Branch ${branch(e)} became ${pr}`;
  },
  "review.run": (e) => {
    const n = num(e.data?.findings) ?? 0;
    return `${actorLabel(e.actor)} ran an AI review of ${pullLabel(str(e.data?.url))}: ${n} finding${n === 1 ? "" : "s"}`;
  },
  "session.adopted": (e) =>
    `opendevhub found session ${sessionOf(e)}, started outside opendevhub`,
  "session.removed": (e) => `The session of ${sessionOf(e)} is gone`,
  "session.started": (e) =>
    e.data?.variant === undefined || e.data.variant === 1
      ? `${actorLabel(e.actor)} started a session for ${task(e)}`
      : `${actorLabel(e.actor)} started the session of variant ${variantN(e)} of ${task(e)}`,
  "task.archived": (e) => `${actorLabel(e.actor)} archived ${task(e)}`,
  "task.ended": (e) =>
    e.taskTitle ? `Task “${e.taskTitle}” ended` : "A task ended",
  "task.started": (e) => {
    const variants = num(e.data?.variants) ?? 1;
    if (e.data?.kind === "manual") {
      return `${actorLabel(e.actor)} started session ${task(e)}`;
    }
    if (e.data?.kind === "review") {
      return `${actorLabel(e.actor)} started review ${task(e)}`;
    }
    return `${actorLabel(e.actor)} started task ${task(e)}${variants > 1 ? ` with ${variants} variants` : ""}`;
  },
  "ticket.linked": (e) =>
    `${e.taskTitle ? `“${e.taskTitle}”` : "A task"} was started from ${str(e.data?.key) ?? "a ticket"}`,
  "variant.discarded": (e) =>
    `${actorLabel(e.actor)} discarded variant ${variantN(e)} of ${task(e)}`,
  "variant.failed": (e) => {
    const error = str(e.data?.error);
    return `Variant ${variantN(e)} of ${task(e)} failed${error ? `: ${error}` : ""}`;
  },
  "variant.picked": (e) =>
    `${actorLabel(e.actor)} picked variant ${variantN(e)} of ${task(e)}`,
  "worktree.adopted": (e) =>
    `opendevhub found worktree ${worktree(e)}, created outside opendevhub`,
  "worktree.created": (e) =>
    `${actorLabel(e.actor)} created worktree ${worktree(e)}`,
  "worktree.removed": (e) =>
    `${actorLabel(e.actor)} removed worktree ${worktree(e)}`,
  "worktree.switched": (e) => {
    const to = str(e.data?.to);
    return `Worktree ${worktree(e)} switched to ${to ?? "a detached HEAD"}`;
  },
};

export const eventText = (e: ActivityEvent): string => EVENT_TEXT[e.verb](e);

/**
 * Where an event leads: its entity's page in the dashboard, or for a pull request or ticket its web URL
 * (`external`). Removed things lead to what is left: the task, else the project.
 */
export const eventLink = (
  e: ActivityEvent
): { href: string } | { external: string } | undefined => {
  const project = e.projectId;
  let fallback: { href: string } | undefined;
  if (project) {
    fallback = {
      href: e.taskId
        ? taskPath(project, e.taskId)
        : `/p/${encodeURIComponent(project)}`,
    };
  }
  switch (e.object.type) {
    case "worktree": {
      const path = str(e.data?.path);
      return project && path && e.verb !== "worktree.removed"
        ? { href: checkoutPath(project, folderName(path)) }
        : fallback;
    }
    case "ticket": {
      const key = str(e.data?.key);
      return key ? { href: `/jira/${encodeURIComponent(key)}` } : fallback;
    }
    case "pull_request":
    case "review": {
      const url = str(e.data?.url);
      return url ? { external: url } : fallback;
    }
    default: {
      return fallback;
    }
  }
};

/** Events from the refreshed first page and the older pages loaded so far, newest first, each once. */
export const mergeEvents = (
  ...lists: readonly (readonly ActivityEvent[])[]
): ActivityEvent[] => {
  const byId = new Map<number, ActivityEvent>();
  for (const list of lists) {
    for (const e of list) {
      byId.set(e.id, e);
    }
  }
  return [...byId.values()].toSorted((a, b) => b.id - a.id);
};

/** A stable key for a feed's filter. */
export const filterKey = (filter: ActivityFilter): string =>
  [
    filter.projectId ?? "",
    filter.taskId ?? "",
    filter.entity ? `${filter.entity.type}:${filter.entity.id}` : "",
  ].join("|");

/** What made a session, worktree, branch or environment, as the chip shows it; a `CheckoutCreator` is one. */
export type Origin =
  | { by: "variant"; task: string; n: number; title: string; kind?: "task" }
  | { by: "session"; task: string; title: string; kind: "manual" | "review" }
  | { by: "manual" }
  | { by: "pull"; url?: string }
  | { by: "unmanaged" };

/** A session's task as an origin: its task and variant, or for a manual or review task the task itself. */
export const sessionOrigin = (ref: SessionTaskRef, title: string): Origin => {
  if (ref.kind === "task") {
    return { by: "variant", n: ref.n, task: ref.id, title };
  }
  if (ref.adopted) {
    return { by: "unmanaged" };
  }
  return { by: "session", kind: ref.kind, task: ref.id, title };
};

/** The chip's text, and where it links. */
export const originLabel = (
  origin: Origin,
  forgejoUrl?: string
): { text: string; href?: string; external?: string } => {
  switch (origin.by) {
    case "variant": {
      return {
        text: `${origin.title || "Task"} · variant ${origin.n}`,
      };
    }
    case "session": {
      return {
        text: origin.kind === "review" ? "AI review" : "Started here",
      };
    }
    case "manual": {
      return { text: "Created here" };
    }
    case "pull": {
      const internal = origin.url
        ? forgejoRoute(origin.url, forgejoUrl)
        : undefined;
      return {
        text: "Pull request checkout",
        ...(internal ? { href: internal } : {}),
        ...(!internal && origin.url ? { external: origin.url } : {}),
      };
    }
    default: {
      return { text: "Created outside opendevhub" };
    }
  }
};
