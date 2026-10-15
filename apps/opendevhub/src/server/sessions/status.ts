import type {
  BackgroundShell,
  ModelRef,
  PendingForm,
  PendingItems,
  PendingPermission,
  SessionStatus,
  SessionSummary,
} from "../../shared/types";
import type {
  RawForm,
  RawMessage,
  RawPermissionRequest,
  RawSession,
  RawShell,
  RawTokens,
} from "../opencode/client";

/** A running shell with the directory opencode listed it for. */
export type LocatedShell = RawShell & { directory: string };

export interface StatusInput {
  /** The environment these sessions come from; copied onto each session. */
  envId?: string;
  sessions: RawSession[];
  active: Set<string>;
  permissions: RawPermissionRequest[];
  forms: RawForm[];
  /** When the monitor first saw each pending item, by item id. */
  firstSeen?: Map<string, number>;
  /** Tokens in each root session's context, by session id (see `contextOf`). */
  contexts?: Map<string, number>;
  /** Running shell commands, by the directory they were listed for. */
  shells?: LocatedShell[];
}

const RANK: Record<SessionStatus, number> = {
  idle: 3,
  "needs-answer": 1,
  "needs-permission": 0,
  running: 2,
};

export const compareSessions = (a: SessionSummary, b: SessionSummary): number =>
  RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt;

export const rootOf = (
  id: string,
  parents: Map<string, string | undefined>
): string => {
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = parents.get(current);
    if (!parent) {
      return current;
    }
    current = parent;
  }
  return current;
};

const toPermission = (
  p: RawPermissionRequest,
  createdAt: number | undefined
): PendingPermission => {
  const diff = [p.metadata?.diff, p.metadata?.patch].find(
    (v): v is string => typeof v === "string"
  );
  return {
    action: p.action,
    id: p.id,
    resources: Array.isArray(p.resources)
      ? p.resources.filter((r): r is string => typeof r === "string")
      : [],
    sessionId: p.sessionID,
    ...(p.save?.length ? { save: p.save } : {}),
    ...(p.message ? { message: p.message } : {}),
    ...(diff ? { diff } : {}),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
};

const toForm = (f: RawForm, createdAt: number | undefined): PendingForm => ({
  fields: Array.isArray(f.fields) ? f.fields : [],
  id: f.id,
  sessionId: f.sessionID,
  title: f.title,
  ...(createdAt === undefined ? {} : { createdAt }),
});

const byAge = (a: { createdAt?: number }, b: { createdAt?: number }) =>
  (a.createdAt ?? 0) - (b.createdAt ?? 0);

const modelOf = (s: RawSession): ModelRef | undefined => {
  if (!s.model?.id || !s.model.providerID) {
    return undefined;
  }
  const { id, providerID, variant } = s.model;
  return {
    id,
    providerID,
    ...(variant && variant !== "default" ? { variant } : {}),
  };
};

/** Every token a model call processed: input, output, reasoning, and cache reads and writes. */
export const tokenTotal = (t: RawTokens): number =>
  (t.input ?? 0) +
  (t.output ?? 0) +
  (t.reasoning ?? 0) +
  (t.cache?.read ?? 0) +
  (t.cache?.write ?? 0);

const tokensOf = (s: RawSession): number | undefined =>
  s.tokens ? tokenTotal(s.tokens) : undefined;

/**
 * The tokens in a session's context as of its latest reply, the "total tokens" opencode shows for it: everything
 * the newest assistant message that used any processed. Undefined when none of `newestFirst` is such a message.
 */
export const contextOf = (newestFirst: RawMessage[]): number | undefined => {
  for (const m of newestFirst) {
    const total = m.type === "assistant" && m.tokens ? tokenTotal(m.tokens) : 0;
    if (total > 0) {
      return total;
    }
  }
  return undefined;
};

export interface RolledUp {
  /** USD; undefined when no session in the tree reports it. */
  cost?: number;
  /** All tokens processed, cache included; undefined when no session in the tree reports them. */
  tokens?: number;
  /** The latest `time.updated` in the tree. */
  updatedAt: number;
}

const plus = (a: number | undefined, b: number | undefined) =>
  b === undefined ? a : (a ?? 0) + b;

/** Each root session with its subagents' (child sessions') cost and tokens added in, by root id. */
export const rollUp = (sessions: RawSession[]): Map<string, RolledUp> => {
  const ids = new Set(sessions.map((s) => s.id));
  // A child whose parent isn't listed is its own root.
  const parents = new Map(
    sessions.map((s) => [
      s.id,
      s.parentID && ids.has(s.parentID) ? s.parentID : undefined,
    ])
  );
  const out = new Map<string, RolledUp>();
  for (const s of sessions) {
    const root = rootOf(s.id, parents);
    const acc = out.get(root) ?? { updatedAt: 0 };
    const cost = plus(
      acc.cost,
      typeof s.cost === "number" ? s.cost : undefined
    );
    const tokens = plus(acc.tokens, tokensOf(s));
    out.set(root, {
      ...(cost === undefined ? {} : { cost }),
      ...(tokens === undefined ? {} : { tokens }),
      updatedAt: Math.max(acc.updatedAt, s.time.updated),
    });
  }
  return out;
};

export const deriveSessions = (
  projectId: string,
  input: StatusInput
): SessionSummary[] => {
  const parents = new Map(input.sessions.map((s) => [s.id, s.parentID]));
  const totals = rollUp(input.sessions);
  const flags = new Map<string, SessionStatus>();
  const pending = new Map<string, PendingItems>();
  const raise = (sessionId: string, status: SessionStatus) => {
    const seen = new Set<string>();
    let id: string | undefined = sessionId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const current = flags.get(id);
      if (!current || RANK[status] < RANK[current]) {
        flags.set(id, status);
      }
      id = parents.get(id);
    }
  };
  const itemsOf = (sessionId: string): PendingItems => {
    const root = rootOf(sessionId, parents);
    let items = pending.get(root);
    if (!items) {
      pending.set(root, (items = { forms: [], permissions: [] }));
    }
    return items;
  };
  const seen = (id: string) => input.firstSeen?.get(id);

  for (const id of input.active) {
    raise(id, "running");
  }
  for (const f of input.forms) {
    raise(f.sessionID, "needs-answer");
    itemsOf(f.sessionID).forms.push(toForm(f, seen(f.id)));
  }
  for (const p of input.permissions) {
    raise(p.sessionID, "needs-permission");
    itemsOf(p.sessionID).permissions.push(toPermission(p, seen(p.id)));
  }

  const children = new Map<string, NonNullable<SessionSummary["subagents"]>>();
  for (const s of input.sessions) {
    if (!s.parentID || s.time.archived !== undefined) {
      continue;
    }
    const root = rootOf(s.id, parents);
    if (root === s.id) {
      continue;
    }
    const entries = children.get(root) ?? [];
    entries.push({
      id: s.id,
      parentId: s.parentID,
      title: s.title?.trim() || "Subagent",
      ...(s.agent ? { agent: s.agent } : {}),
      updatedAt: s.time.updated,
      status: flags.get(s.id) ?? "idle",
      ...(s.outcome ? { outcome: s.outcome } : {}),
    });
    children.set(root, entries);
  }

  const shells = new Map<string, BackgroundShell[]>();
  for (const sh of input.shells ?? []) {
    const sessionId = sh.metadata?.sessionID;
    if (sh.status !== "running" || typeof sessionId !== "string") {
      continue;
    }
    const root = rootOf(sessionId, parents);
    const entries = shells.get(root) ?? [];
    entries.push({
      command: sh.command,
      directory: sh.directory,
      id: sh.id,
      sessionId,
      startedAt: sh.time.started,
    });
    shells.set(root, entries);
  }

  return input.sessions
    .filter((s) => !s.parentID && s.time.archived === undefined)
    .map((s) => {
      const items = pending.get(s.id);
      const model = modelOf(s);
      const { cost, tokens } = totals.get(s.id) ?? {};
      const context = input.contexts?.get(s.id);
      return {
        id: s.id,
        projectId,
        ...(input.envId ? { envId: input.envId } : {}),
        title: s.title?.trim() || "Untitled session",
        directory: s.location.directory,
        updatedAt: s.time.updated,
        status: flags.get(s.id) ?? "idle",
        ...(items
          ? {
              pending: {
                forms: items.forms.toSorted(byAge),
                permissions: items.permissions.toSorted(byAge),
              },
            }
          : {}),
        ...(model ? { model } : {}),
        ...(cost === undefined ? {} : { cost }),
        ...(tokens === undefined ? {} : { tokens }),
        ...(context === undefined ? {} : { context }),
        ...(children.has(s.id)
          ? {
              subagents: children
                .get(s.id)
                ?.toSorted((a, b) => b.updatedAt - a.updatedAt),
            }
          : {}),
        ...(shells.has(s.id)
          ? {
              shells: shells
                .get(s.id)
                ?.toSorted((a, b) => a.startedAt - b.startedAt),
            }
          : {}),
      };
    })
    .toSorted(compareSessions);
};
