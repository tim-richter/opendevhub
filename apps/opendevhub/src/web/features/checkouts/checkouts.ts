import type {
  ProjectView,
  PublicRuntime,
  SessionSummary,
  TaskKind,
  TaskState,
  Worktree,
} from "../../../shared/types";
import { chatHref, taskHref } from "../../../shared/urls";
import type { TaskTab } from "../../../shared/urls";
import {
  envOfDirectory,
  envTone,
  needsAttention,
  workspaceFolderOf,
} from "../../derive";
import type { Tone } from "../../derive";

/** A place a project is checked out: the main checkout or one of its worktrees. */
export interface Checkout {
  /** "" for the main checkout, else the worktree's folder name (also its URL segment). */
  target: string;
  label: string;
  /** Path inside the container. */
  directory: string;
  /** Same checkout on this machine, when there is one. */
  hostPath?: string;
  worktree?: Worktree;
}

export type CheckoutTab = "review" | "runtime";

const folderName = (path: string) => path.split("/").findLast(Boolean) ?? path;

/** The main checkout first, then the worktrees in the order git lists them. */
export const checkouts = (view: ProjectView): Checkout[] => [
  {
    directory: workspaceFolderOf(view),
    hostPath: view.project.path,
    label: "Main checkout",
    target: "",
  },
  ...(view.runtime.worktrees ?? []).map((w) => ({
    directory: w.path,
    hostPath: w.hostPath,
    label: w.branch ?? folderName(w.path),
    target: folderName(w.path),
    worktree: w,
  })),
];

export const checkoutOf = (
  view: ProjectView,
  directory: string
): Checkout | undefined =>
  checkouts(view).find((c) => c.directory === directory);

/** `main` for the main checkout and `w/<folder>` for a worktree, so a worktree named "main" can't clash. */
export const checkoutPath = (
  projectId: string,
  target: string,
  tab?: CheckoutTab
): string => {
  const base = `/p/${encodeURIComponent(projectId)}/${target ? `w/${encodeURIComponent(target)}` : "main"}`;
  return tab ? `${base}/${tab}` : base;
};

/** The Saved permissions section's anchor on a checkout's Container tab. */
export const SAVED_PERMISSIONS_ID = "saved-permissions";

/** The Saved permissions section of the environment a checkout runs in, or undefined for an unknown checkout. */
export const savedPermissionsPath = (
  view: ProjectView,
  directory: string
): string | undefined => {
  const checkout = checkoutOf(view, directory);
  return checkout
    ? `${checkoutPath(view.project.id, checkout.target, "runtime")}#${SAVED_PERMISSIONS_ID}`
    : undefined;
};

/**
 * Where a session lives: its task's Conversation tab with its variant selected (and the session as the thread when it
 * isn't the variant's own), else its checkout's page while the session has no task yet, else the project overview.
 */
export const sessionPath = (
  view: ProjectView,
  session: SessionSummary
): string => {
  const ref = session.task;
  if (ref) {
    const own = view.tasks
      .find((t) => t.id === ref.id)
      ?.variants.find((v) => v.n === ref.n)?.sessionId;
    return taskHref(view.project.id, ref.id, {
      v: ref.n,
      ...(own && own !== session.id ? { thread: session.id } : {}),
    });
  }
  if (session.chat) {
    return chatHref(view.project.id, session.chat);
  }
  const c = checkoutOf(view, session.directory);
  return c
    ? checkoutPath(view.project.id, c.target)
    : `/p/${encodeURIComponent(view.project.id)}?session=${encodeURIComponent(session.id)}`;
};

export const checkoutCounts = (
  view: ProjectView,
  directory: string
): { attention: number; running: number; idle: number } => {
  const counts = { attention: 0, idle: 0, running: 0 };
  for (const s of view.sessions) {
    if (s.directory !== directory) {
      continue;
    }
    if (needsAttention(s.status)) {
      counts.attention += 1;
    } else if (s.status === "running") {
      counts.running += 1;
    } else {
      counts.idle += 1;
    }
  }
  return counts;
};

/** The container a checkout runs in: its own when it has one, else the project's. */
export const checkoutRuntime = (
  view: ProjectView,
  directory: string
): PublicRuntime => envOfDirectory(view, directory)?.runtime ?? view.runtime;

/** Like projectTone, but from one checkout's sessions and the container it runs in. */
export const checkoutTone = (view: ProjectView, directory: string): Tone => {
  const c = checkoutCounts(view, directory);
  if (c.attention > 0) {
    return "attention";
  }
  if (c.running > 0) {
    return "running";
  }
  const env = envOfDirectory(view, directory);
  if (env) {
    return envTone(env);
  }
  return view.runtime.containerState === "running" ? "ok" : "off";
};

export interface ProjectTask {
  task: string;
  title: string;
  kind: TaskKind;
  state: TaskState;
  variants: number;
  attention: boolean;
  running: boolean;
  updatedAt: number;
  /** The variant whose conversation waits on the user, which its link selects. */
  waiting?: number;
  /** Made from a chat, which became its variant 1. */
  fromChat?: true;
  /** The checkouts its sessions run in. */
  directories: string[];
}

/** Every task of the project, most recent first. */
export const projectTasks = (view: ProjectView): ProjectTask[] =>
  view.tasks
    .map((t): ProjectTask => {
      const sessions = view.sessions.filter((s) => s.task?.id === t.id);
      const waiting = sessions.find((s) => needsAttention(s.status))?.task?.n;
      return {
        attention:
          waiting !== undefined ||
          t.variants.some((v) => v.step === "failed" && !v.discarded),
        directories: [...new Set(sessions.map((s) => s.directory))],
        kind: t.kind,
        running:
          t.state === "starting" ||
          sessions.some((s) => s.status === "running"),
        state: t.state,
        task: t.id,
        title: t.title,
        updatedAt: Math.max(t.createdAt, ...sessions.map((s) => s.updatedAt)),
        variants: t.variants.length,
        ...(waiting === undefined ? {} : { waiting }),
        ...(t.fromChat ? { fromChat: true as const } : {}),
      };
    })
    .toSorted((a, b) => b.updatedAt - a.updatedAt);

/** The tasks whose conversations run in a checkout, most recent first. */
export const checkoutTasks = (
  view: ProjectView,
  directory: string
): ProjectTask[] =>
  projectTasks(view).filter((t) => t.directories.includes(directory));

/** Whether a still-listed task's variant that created the worktree is starting or running. */
const ownedByAliveVariant = (
  view: ProjectView,
  creator: Worktree["createdBy"] | undefined
): boolean => {
  if (creator?.by !== "variant") {
    return false;
  }
  return view.tasks.some(
    (t) =>
      t.id === creator.task &&
      t.variants.some(
        (v) => v.n === creator.n && !v.discarded && v.step !== "failed"
      )
  );
};

/**
 * The checkouts with a page of their own: the main checkout and the worktrees a task variant isn't currently
 * starting or running (failed or discarded variants surface their worktrees as standalone checkouts too).
 */
export const standaloneCheckouts = (view: ProjectView): Checkout[] =>
  checkouts(view).filter(
    (c) => !c.worktree || !ownedByAliveVariant(view, c.worktree.createdBy)
  );

/** Where the project tabs of earlier versions went. */
export const legacyPath = (
  projectId: string,
  tab: "review" | "ports" | "logs" | "worktrees",
  target = ""
): string => {
  if (tab === "worktrees") {
    return `/p/${encodeURIComponent(projectId)}`;
  }
  return checkoutPath(
    projectId,
    target,
    tab === "review" ? "review" : "runtime"
  );
};

/** The checkout tabs a worktree created by a task maps to on the task page, or its Review page. */
const TASK_TAB_OF: Record<string, TaskTab | "review"> = {
  "": "conversation",
  review: "review",
  runtime: "runtime",
  terminal: "terminal",
};

/**
 * Where a worktree page goes when a still-active task variant created the worktree: that task, with the variant
 * selected, on the matching tab. Undefined for the main checkout, worktrees no (listed) task created, and worktrees
 * of failed or discarded variants, which keep their own page.
 */
export const worktreeRedirect = (
  view: ProjectView,
  checkout: Checkout,
  tab = ""
): string | undefined => {
  const creator = checkout.worktree?.createdBy;
  if (
    creator?.by !== "variant" ||
    !(tab in TASK_TAB_OF) ||
    !ownedByAliveVariant(view, creator)
  ) {
    return undefined;
  }
  return taskHref(view.project.id, creator.task, {
    tab: TASK_TAB_OF[tab],
    v: creator.n,
  });
};

/**
 * Where an old session page (`…/s/:session`) goes: the session's task with its variant (and the session as the thread
 * when it isn't the variant's own), found from the session or, once it is gone, from the variant that ran it; else the
 * checkout's page.
 */
export const sessionRedirect = (
  view: ProjectView,
  target: string,
  sessionId: string
): string => {
  const session = view.sessions.find((s) => s.id === sessionId);
  if (session?.task || session?.chat) {
    return sessionPath(view, session);
  }
  for (const t of view.tasks) {
    const v = t.variants.find((x) => x.sessionId === sessionId);
    if (v) {
      return taskHref(view.project.id, t.id, { v: v.n });
    }
  }
  const chat = view.chats.find((c) => c.sessionId === sessionId);
  if (chat) {
    return chatHref(view.project.id, chat.id);
  }
  return checkoutPath(view.project.id, target);
};

/** The Tasks page's filters: what needs the user, each state, and drafts. */
export type TaskFilter =
  | "all"
  | "attention"
  | "running"
  | "idle"
  | "ended"
  | "draft";

export const matchesTaskFilter = (t: ProjectTask, f: TaskFilter): boolean => {
  const draft = t.state === "draft";
  const ended = t.state === "ended" || draft;
  switch (f) {
    case "all": {
      return true;
    }
    case "draft": {
      return draft;
    }
    case "attention": {
      return t.attention && !ended;
    }
    case "running": {
      return t.running && !t.attention && !ended;
    }
    case "idle": {
      return !t.running && !t.attention && !ended;
    }
    case "ended": {
      return t.state === "ended";
    }
    default: {
      return false;
    }
  }
};

/** Where the old Sessions page's `status` filter goes on the Tasks page. */
export const tasksPathFromSessions = (status: string | undefined): string => {
  let filter: TaskFilter | undefined;
  if (status === "running" || status === "idle" || status === "attention") {
    filter = status;
  } else if (status?.startsWith("needs-")) {
    filter = "attention";
  }
  return filter ? `/tasks?status=${filter}` : "/tasks";
};
