import type {
  ChatTarget,
  ChatView,
  DashboardSnapshot,
  ProjectView,
} from "../../../shared/types";
import { chatHref } from "../../../shared/urls";
import { workspaceFolderOf } from "../../derive";
import type { Tone } from "../../derive";
import { checkouts } from "../checkouts/checkouts";

/** The project the start composer picks on this browser, as long as it is still registered. */
export const LAST_PROJECT_KEY = "opendevhub.chat.project";

/** The checkout picker's value for a new worktree; the others are checkout directories. */
export const NEW_WORKTREE = "worktree";

export const WORKTREES_UNAVAILABLE =
  "The project's container has no worktrees folder; rebuild it to enable worktrees.";

/** A chat's own page: its conversation full-width. */
export const chatPath = chatHref;

/** The search param that carries a message for Chat's start page to put in its composer. */
export const CHAT_PROMPT_PARAM = "prompt";

/** Chat's start page, with `prompt` in the composer ready to send. */
export const chatStartHref = (prompt: string) =>
  `/chat?${new URLSearchParams({ [CHAT_PROMPT_PARAM]: prompt })}`;

/** How many of the project's chats the sidebar lists before "Show all". */
export const SIDEBAR_CHATS = 20;

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_HOURS = 24;

/** A task id, as old chat links carried in place of the chat's. */
export const isTaskId = (id: string): boolean => id.startsWith("tsk_");

export const chatOf = (view: ProjectView, chat: string): ChatView | undefined =>
  view.chats.find((c) => c.id === chat);

/** When a chat was last active: its session's last update, else its creation. */
export const chatActivity = (chat: ChatView): number =>
  chat.updatedAt ?? chat.createdAt;

/** Waiting on a permission or a question. */
export const chatNeedsYou = (chat: ChatView): boolean =>
  (chat.pending?.permissions.length ?? 0) + (chat.pending?.forms.length ?? 0) >
  0;

/** A chat's dot: waiting on the user, working, idle, or not started yet. */
export const chatTone = (chat: ChatView): Tone => {
  if (chatNeedsYou(chat)) {
    return "attention";
  }
  if (chat.step === "failed") {
    return "error";
  }
  if (chat.status === "running" || chat.step !== "session") {
    return "running";
  }
  return chat.status ? "ok" : "off";
};

/** A chat with the project it belongs to. */
export interface ListedChat {
  chat: ChatView;
  projectId: string;
  projectName: string;
}

/** Every project's chats, most recently active first; only `projectId`'s when given. */
export const allChats = (
  snapshot: DashboardSnapshot,
  projectId?: string
): ListedChat[] =>
  snapshot.projects
    .filter((v) => projectId === undefined || v.project.id === projectId)
    .flatMap((v) =>
      v.chats.map((chat) => ({
        chat,
        projectId: v.project.id,
        projectName: v.project.name,
      }))
    )
    .toSorted((a, b) => chatActivity(b.chat) - chatActivity(a.chat));

/** The project's chats the sidebar lists: not archived, most recently active first. */
export const sidebarChats = (view: ProjectView): ChatView[] =>
  view.chats
    .filter((c) => !c.archived)
    .toSorted((a, b) => chatActivity(b) - chatActivity(a));

/** How long ago, as the sidebar shows it: "now", "5m", "3h", "2d". */
export const shortAgo = (ts: number, now = Date.now()): string => {
  const minutes = Math.floor(Math.max(0, now - ts) / MINUTE_MS);
  if (minutes < 1) {
    return "now";
  }
  if (minutes < HOUR_MINUTES) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / HOUR_MINUTES);
  return hours < DAY_HOURS ? `${hours}h` : `${Math.floor(hours / DAY_HOURS)}d`;
};

/** A project's chats run in one checkout, most recently active first. */
export const checkoutChats = (
  view: ProjectView,
  directory: string
): ChatView[] =>
  view.chats
    .filter((c) => c.directory === directory)
    .toSorted((a, b) => chatActivity(b) - chatActivity(a));

/** Runs in the project's main checkout rather than a worktree. */
export const inMainCheckout = (view: ProjectView, chat: ChatView): boolean =>
  !chat.branch || chat.directory === workspaceFolderOf(view);

export const MAIN_CHECKOUT_TASK = "Only chats in a worktree can become tasks.";

/** Why Make task is off for a chat; undefined when it can make one. */
export const makeTaskBlocked = (
  view: ProjectView,
  chat: ChatView
): string | undefined => {
  if (chat.adoptedBy) {
    return "This chat already belongs to a task.";
  }
  if (!chat.sessionId || chat.sessionRemoved) {
    return "This chat has no conversation.";
  }
  if (inMainCheckout(view, chat)) {
    return MAIN_CHECKOUT_TASK;
  }
  return undefined;
};

export const readLastProject = (): string | undefined => {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY) ?? undefined;
  } catch {
    return undefined;
  }
};

export const rememberProject = (projectId: string): void => {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, projectId);
  } catch {
    // Not remembered; the picker falls back to the first project.
  }
};

/** The registered projects by name. */
export const chatProjects = (snapshot: DashboardSnapshot): ProjectView[] =>
  snapshot.projects.toSorted((a, b) =>
    a.project.name.localeCompare(b.project.name)
  );

/** The project the start composer opens with: the last one chatted in, else the first by name. */
export const defaultChatProject = (
  projects: ProjectView[],
  last: string | undefined
): ProjectView | undefined =>
  projects.find((v) => v.project.id === last) ?? projects[0];

export const canCreateWorktree = (view: ProjectView): boolean =>
  view.runtime.worktreeRoot?.mounted === true;

export interface CheckoutChoice {
  value: string;
  label: string;
  disabled?: boolean;
}

/** New worktree, the main checkout, then each worktree by branch or folder name. */
export const checkoutChoices = (view: ProjectView): CheckoutChoice[] => [
  {
    label: "New worktree",
    value: NEW_WORKTREE,
    ...(canCreateWorktree(view) ? {} : { disabled: true }),
  },
  ...checkouts(view).map((c) => ({ label: c.label, value: c.directory })),
];

/** The main checkout. */
export const defaultCheckoutChoice = (view: ProjectView): string =>
  workspaceFolderOf(view);

/** What the composer is scoped to and where the start request sends the chat. */
export const chatTarget = (
  view: ProjectView,
  choice: string
): { directory: string; label: string; target: ChatTarget } => {
  if (choice === NEW_WORKTREE) {
    return {
      directory: workspaceFolderOf(view),
      label: "New worktree",
      target: { kind: "worktree" },
    };
  }
  const label =
    checkoutChoices(view).find((c) => c.value === choice)?.label ?? choice;
  return {
    directory: choice,
    label,
    target: { directory: choice, kind: "checkout" },
  };
};
