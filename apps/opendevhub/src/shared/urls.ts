export const projectUrl = (projectId: string, port: number): string =>
  `http://${projectId}.localhost:${port}/`;

export const sessionUrl = (projectBase: string, sessionId: string): string => {
  const origin = projectBase.replace(/\/$/u, "");
  const key = btoa(origin)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${origin}/server/${key}/session/${sessionId}`;
};

/** A tab of a task page; the Conversation tab is the task's own path. */
export type TaskTab =
  | "conversation"
  | "changes"
  | "terminal"
  | "runtime"
  | "spec"
  | "checks"
  | "compare";

/** A task page, optionally on a tab (or its Review page, outside the tabs), with a variant (`?v=`) and a conversation thread (`?thread=`) selected. */
export const taskHref = (
  projectId: string,
  taskId: string,
  opts: { v?: number; thread?: string; tab?: TaskTab | "review" } = {}
): string => {
  const base = `/p/${encodeURIComponent(projectId)}/t/${encodeURIComponent(taskId)}`;
  const path =
    opts.tab && opts.tab !== "conversation" ? `${base}/${opts.tab}` : base;
  const search = new URLSearchParams();
  if (opts.v !== undefined) {
    search.set("v", String(opts.v));
  }
  if (opts.thread) {
    search.set("thread", opts.thread);
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
};

/** A chat's view. */
export const chatHref = (projectId: string, chatId: string): string =>
  `/chat/${encodeURIComponent(projectId)}/${encodeURIComponent(chatId)}`;
