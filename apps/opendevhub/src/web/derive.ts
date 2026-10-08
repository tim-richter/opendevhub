import type {
  DashboardSnapshot,
  EnvironmentView,
  ProjectView,
  PublicRuntime,
  SessionStatus,
  SessionSummary,
} from "../shared/types";
import { sessionUrl } from "../shared/urls";

/** Tags of shown notifications whose permission or question is no longer pending; other tags never go stale. */
export const staleNotificationTags = (
  snapshot: DashboardSnapshot,
  tags: string[]
): string[] => {
  const pending = new Set<string>();
  for (const view of snapshot.projects) {
    for (const s of view.sessions) {
      for (const p of s.pending?.permissions ?? []) {
        pending.add(`perm:${p.id}`);
      }
      for (const f of s.pending?.forms ?? []) {
        pending.add(`form:${f.id}`);
      }
    }
  }
  return tags.filter(
    (tag) => /^(?<g1>perm|form):[^:]+$/u.test(tag) && !pending.has(tag)
  );
};

export const attentionCounts = (
  snapshot: DashboardSnapshot
): {
  attention: number;
  running: number;
} => {
  let attention = 0;
  let running = 0;
  for (const view of snapshot.projects) {
    for (const s of view.sessions) {
      if (s.status === "needs-permission" || s.status === "needs-answer") {
        attention += 1;
      } else if (s.status === "running") {
        running += 1;
      }
    }
  }
  return { attention, running };
};

export const relativeTime = (ts: number, now = Date.now()): string => {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) {
    return "just now";
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  return `${Math.round(hours / 24)} d ago`;
};

export const needsAttention = (status: SessionStatus): boolean =>
  status === "needs-permission" || status === "needs-answer";

const STATUS_RANK: Record<SessionStatus, number> = {
  idle: 2,
  "needs-answer": 0,
  "needs-permission": 0,
  running: 1,
};

/** Attention first, then running, then idle; most recently updated first within each. */
export const compareSessions = (a: SessionSummary, b: SessionSummary): number =>
  STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.updatedAt - a.updatedAt;

export interface ProjectCounts {
  attention: number;
  running: number;
  idle: number;
  ports: number;
}

export const projectCounts = (view: ProjectView): ProjectCounts => {
  const counts = { attention: 0, idle: 0, ports: 0, running: 0 };
  for (const s of view.sessions) {
    if (needsAttention(s.status)) {
      counts.attention += 1;
    } else if (s.status === "running") {
      counts.running += 1;
    } else {
      counts.idle += 1;
    }
  }
  counts.ports =
    view.runtime.ports?.filter((p) => p.status === "forwarded").length ?? 0;
  return counts;
};

export type Tone = "attention" | "error" | "busy" | "running" | "ok" | "off";

/** One colour for a project, worst signal wins. */
export const projectTone = (view: ProjectView): Tone => {
  const { runtime } = view;
  if (view.sessions.some((s) => needsAttention(s.status))) {
    return "attention";
  }
  if (runtime.containerState === "error" || runtime.opencode === "unhealthy") {
    return "error";
  }
  if (
    runtime.containerState === "starting" ||
    runtime.containerState === "stopping" ||
    runtime.opencode === "starting"
  ) {
    return "busy";
  }
  if (view.sessions.some((s) => s.status === "running")) {
    return "running";
  }
  if (runtime.containerState === "running") {
    return "ok";
  }
  return "off";
};

export interface SessionEntry {
  session: SessionSummary;
  view: ProjectView;
}

export const allSessions = (snapshot: DashboardSnapshot): SessionEntry[] => {
  const entries: SessionEntry[] = [];
  for (const view of snapshot.projects) {
    for (const session of view.sessions) {
      entries.push({ session, view });
    }
  }
  return entries.toSorted((a, b) => compareSessions(a.session, b.session));
};

export const matches = (
  query: string,
  ...fields: (string | undefined)[]
): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) {
    return true;
  }
  return fields.some((f) => f?.toLowerCase().includes(q));
};

/** Where the project is checked out inside its container (mirrors the server's fallback). */
export const workspaceFolderOf = (view: ProjectView): string => {
  const base = view.project.path.split("/").findLast(Boolean) ?? "";
  return view.runtime.workspaceFolder ?? `/workspaces/${base}`;
};

/** A short name for the worktree a session works in; undefined for the main checkout. */
export const worktreeLabel = (
  view: ProjectView,
  directory: string
): string | undefined => {
  if (directory === workspaceFolderOf(view)) {
    return undefined;
  }
  const wt = view.runtime.worktrees?.find((w) => w.path === directory);
  return wt?.branch ?? directory.split("/").findLast(Boolean) ?? directory;
};

export const shellQuote = (value: string): string =>
  /^[\w@%+=:,./-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;

/** A shell inside the container at `directory`, as the dev container's user, preferring bash. */
export const containerShellCommand = (
  view: ProjectView,
  directory: string
): string | undefined => {
  const { containerName, remoteUser } = (
    envOfDirectory(view, directory) ?? view
  ).runtime;
  if (!containerName) {
    return undefined;
  }
  const user = remoteUser ? ` -u ${shellQuote(remoteUser)}` : "";
  const shell = "command -v bash >/dev/null && exec bash -l || exec sh -l";
  return `docker exec -it${user} -w ${shellQuote(directory)} ${shellQuote(containerName)} sh -c ${shellQuote(shell)}`;
};

/** The worktree's own container, when it has one. */
export const envOfDirectory = (
  view: ProjectView,
  directory: string
): EnvironmentView | undefined =>
  view.environments.find((e) => e.worktree.path === directory);

/** The opencode URL of an environment; the project's for the main one or one that is gone. */
export const openUrlOf = (
  view: ProjectView,
  envId: string | undefined
): string =>
  (envId && view.environments.find((e) => e.id === envId)?.openUrl) ||
  view.openUrl;

/** A session in the opencode that runs it. */
export const sessionHref = (
  view: ProjectView,
  session: SessionSummary
): string => sessionUrl(openUrlOf(view, session.envId), session.id);

export const envTone = (env: EnvironmentView): Tone => {
  const { containerState, opencode } = env.runtime;
  if (
    containerState === "error" ||
    (containerState === "running" && opencode === "unhealthy")
  ) {
    return "error";
  }
  if (
    containerState === "starting" ||
    containerState === "stopping" ||
    opencode === "starting"
  ) {
    return "busy";
  }
  return containerState === "running" ? "ok" : "off";
};

/** The ssh-agent badge for a running container; nothing when forwarding is off or not known yet. */
export const sshAgentBadge = (
  runtime: PublicRuntime
): { label: string; warn: boolean; title: string } | undefined => {
  if (runtime.containerState !== "running") {
    return undefined;
  }
  if (runtime.sshAgent === "forwarded" && runtime.sshAgentReason) {
    return {
      label: "ssh-agent has no keys",
      title: runtime.sshAgentReason,
      warn: true,
    };
  }
  if (runtime.sshAgent === "forwarded") {
    return {
      label: "ssh-agent forwarded",
      title:
        "Your ssh-agent is forwarded into this container while opendevhub runs",
      warn: false,
    };
  }
  if (runtime.sshAgent === "unavailable") {
    return {
      label: "ssh-agent unavailable",
      title: runtime.sshAgentReason ?? "See the log on the Runtime tab",
      warn: true,
    };
  }
  return undefined;
};
