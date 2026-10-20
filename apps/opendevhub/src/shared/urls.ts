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

const ENV_HOST = /^(?<env>[a-z0-9-]+)\.localhost$/u;

/**
 * The dashboard link that opens `url`, a page on an environment host: the server hands out a one-time
 * code there, which the environment host exchanges for its own cookie. Other URLs are left as they are.
 */
export const enterUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const env = ENV_HOST.exec(parsed.hostname)?.groups?.env;
  if (!env) {
    return url;
  }
  const next = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return `/api/envs/${env}/enter?next=${encodeURIComponent(next)}`;
};

/** A link that opens a session in its environment's opencode, through `enterUrl`. */
export const sessionLink = (projectBase: string, sessionId: string): string =>
  enterUrl(sessionUrl(projectBase, sessionId));

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
