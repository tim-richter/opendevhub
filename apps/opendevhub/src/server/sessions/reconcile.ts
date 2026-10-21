import type { EnvId, ProjectId } from "../../shared/types";
import type { ChatStore } from "../db/chats";
import type { TaskStore } from "../db/tasks";
import type { RawSession } from "../opencode/client";

/** What opencode says about a session it didn't list: still there, gone (deleted or archived), or no answer. */
export type Presence = "alive" | "gone" | "unknown";

/** Sessions looked up one by one per pass, at most. */
const MAX_LOOKUPS = 20;

export interface ReconcileInput {
  projectId: ProjectId;
  envId: EnvId;
  /** One successful listing of the environment's sessions, subagents and archived ones included. */
  sessions: RawSession[];
  /** The branch checked out in a directory, when it is a worktree. */
  branchOf: (directory: string) => string | undefined;
  /** The worktree row and branch row of a directory, when opendevhub recorded it. */
  rowsOf?: (directory: string) => { branchId?: number; worktreeId?: number };
  /** Asks opencode about one session; the listing holds only the newest ones. */
  lookup: (sessionId: string) => Promise<Presence>;
  /**
   * Whether opendevhub archived this session itself (and so archived it in opencode too). Such a session is still
   * there for cleanup to delete, so being archived in opencode doesn't make it gone.
   */
  keptArchived?: (sessionId: string) => boolean;
}

export interface ReconcileStores {
  tasks: Pick<
    TaskStore,
    "sessionRef" | "isClaimed" | "liveSessionsIn" | "markSessionsGone"
  >;
  chats: Pick<
    ChatStore,
    "hasSession" | "insert" | "setTitle" | "liveSessionsIn" | "markSessionsGone"
  >;
}

/**
 * Brings tasks and chats in line with an environment's sessions after a successful listing: records top-level
 * sessions that neither a variant nor a chat has as chats from opencode (except in directories where opendevhub is
 * creating a session), lets chats' titles follow their sessions, and marks variants' and chats' sessions removed or
 * back. Adoption and titles happen before the first await, so the sessions the listing reports already have their
 * owners.
 */
export const reconcileSessions = async (
  { tasks, chats }: ReconcileStores,
  input: ReconcileInput
): Promise<void> => {
  const { envId, projectId } = input;
  const listed = input.sessions.filter(
    (s) => !s.parentID && s.time.archived === undefined
  );
  for (const s of listed) {
    const title = s.title?.trim() || "Untitled session";
    if (tasks.sessionRef(s.id)) {
      continue;
    }
    if (chats.hasSession(s.id)) {
      chats.setTitle(s.id, title);
      continue;
    }
    const { directory } = s.location;
    if (tasks.isClaimed(envId, directory)) {
      // Its creator is about to attach it; a later pass adopts it if that never happens.
      continue;
    }
    const branch = input.branchOf(directory);
    const rows = input.rowsOf?.(directory) ?? {};
    chats.insert({
      createdAt: s.time.created,
      directory,
      envId,
      origin: "opencode",
      projectId,
      sessionId: s.id,
      step: "session",
      title,
      ...(branch ? { branch } : {}),
      ...(rows.branchId === undefined ? {} : { branchId: rows.branchId }),
      ...(rows.worktreeId === undefined ? {} : { worktreeId: rows.worktreeId }),
    });
  }
  const present = new Set(listed.map((s) => s.id));
  const archived = new Set<string>();
  for (const s of input.sessions) {
    if (s.time.archived === undefined) {
      continue;
    }
    if (input.keptArchived?.(s.id)) {
      present.add(s.id);
    } else {
      archived.add(s.id);
    }
  }
  const live = () => [
    ...tasks.liveSessionsIn(envId),
    ...chats.liveSessionsIn(envId),
  ];
  const known = new Set(live());
  const unlisted = [...known].filter(
    (id) => !present.has(id) && !archived.has(id)
  );
  if (unlisted.length > 0) {
    const answers = await Promise.all(
      unlisted.map((id, i) =>
        i < MAX_LOOKUPS ? input.lookup(id) : Promise.resolve("unknown" as const)
      )
    );
    for (const [i, id] of unlisted.entries()) {
      if (answers[i] !== "gone") {
        present.add(id);
      }
    }
    // Sessions attached while opencode was asked are newer than the listing, which can't speak for them.
    for (const id of live()) {
      if (!known.has(id)) {
        present.add(id);
      }
    }
  }
  tasks.markSessionsGone(envId, present);
  chats.markSessionsGone(envId, present);
};
