import { FIRST_TURN_INTERRUPTED, FIRST_TURN_SENDING } from "../../shared/tasks";
import type {
  ChatOrigin,
  ChatView,
  EnvId,
  ProjectId,
  StartStep,
} from "../../shared/types";
import { newChatId } from "../projects/ids";
import { transaction } from "./database";
import type { Db } from "./database";
import { SYSTEM, USER, record } from "./events";
import type { Actor, EventVerb } from "./events";
import { RESTART_ERROR, settingUp } from "./task-state";

/** A chat with what the snapshot leaves out. */
export interface ChatRecord extends ChatView {
  projectId: ProjectId;
  branchId?: number;
  archivedAt?: number;
}

export interface NewChat {
  /** A new id is made from `createdAt` when absent. */
  id?: string;
  projectId: ProjectId;
  origin: ChatOrigin;
  title: string;
  /** `session` when the session already exists; `queued` for a new worktree still to be set up. */
  step: StartStep;
  createdAt: number;
  sessionId?: string;
  envId?: EnvId;
  directory?: string;
  branch?: string;
  branchId?: number;
  worktreeId?: number;
}

export type ChatPatch = Partial<{
  step: StartStep;
  /** null clears it. */
  error: string | null;
  branch: string;
  directory: string;
  envId: EnvId;
  branchId: number;
  worktreeId: number;
}>;

export interface RawChat {
  id: string;
  project_id: string;
  session_id: string | null;
  env_id: string | null;
  directory: string | null;
  branch: string | null;
  branch_id: number | null;
  worktree_id: number | null;
  origin: ChatOrigin;
  title: string;
  step: StartStep;
  error: string | null;
  created_at: number;
  session_removed_at: number | null;
  archived_at: number | null;
  adopted_task: string | null;
  adopted_variant: number | null;
}

const PATCH_COLUMNS: Record<keyof ChatPatch, string> = {
  branch: "branch",
  branchId: "branch_id",
  directory: "directory",
  envId: "env_id",
  error: "error",
  step: "step",
  worktreeId: "worktree_id",
};

export const toChat = (r: RawChat): ChatRecord => ({
  createdAt: r.created_at,
  id: r.id,
  origin: r.origin,
  projectId: r.project_id,
  step: r.step,
  title: r.title,
  ...(r.session_id ? { sessionId: r.session_id } : {}),
  ...(r.env_id ? { envId: r.env_id } : {}),
  ...(r.directory ? { directory: r.directory } : {}),
  ...(r.branch ? { branch: r.branch } : {}),
  ...(r.branch_id === null ? {} : { branchId: r.branch_id }),
  ...(r.worktree_id === null ? {} : { worktreeId: r.worktree_id }),
  ...(r.error ? { error: r.error } : {}),
  ...(r.session_removed_at === null ? {} : { sessionRemoved: true }),
  ...(r.archived_at === null
    ? {}
    : { archived: true, archivedAt: r.archived_at }),
  ...(r.adopted_task !== null && r.adopted_variant !== null
    ? { adoptedBy: { n: r.adopted_variant, task: r.adopted_task } }
    : {}),
});

/**
 * Chats: the sessions in a project's checkouts that no task variant owns, whether opendevhub started them or found
 * them in opencode. A chat's row exists before its session when Chat sets up a new worktree for it, and is kept after
 * a task adopts it, so that its view can redirect. Every change writes its events in the same transaction;
 * `subscribe` hears about each change.
 */
export class ChatStore {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private sessions?: Map<
    string,
    { id: string; origin: ChatOrigin; adopted: boolean }
  >;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /**
   * Records a chat: `chat.discovered` for one found in opencode (by the system), `chat.started` otherwise. With a
   * session that already has a chat, returns that one.
   */
  insert(chat: NewChat, actor?: Actor): ChatRecord {
    const existing = chat.sessionId
      ? this.bySession(chat.sessionId)
      : undefined;
    if (existing) {
      return existing;
    }
    const id = chat.id ?? newChatId(chat.createdAt);
    const at = this.now();
    const verb: EventVerb =
      chat.origin === "opencode" ? "chat.discovered" : "chat.started";
    const by = actor ?? (chat.origin === "opencode" ? SYSTEM : USER);
    this.write(() => {
      this.db
        .prepare(
          `INSERT INTO chats (id, project_id, session_id, env_id, directory, branch, branch_id, worktree_id, origin,
             title, step, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          chat.projectId,
          chat.sessionId ?? null,
          chat.envId ?? null,
          chat.directory ?? null,
          chat.branch ?? null,
          chat.branchId ?? null,
          chat.worktreeId ?? null,
          chat.origin,
          chat.title,
          chat.step,
          chat.createdAt
        );
      this.event(at, by, verb, chat.projectId, id, {
        origin: chat.origin,
        title: chat.title,
        ...(chat.sessionId ? { session: chat.sessionId } : {}),
      });
    });
    return this.get(id) as ChatRecord;
  }

  /** Records a starting chat's progress. */
  update(id: string, patch: ChatPatch): void {
    const columns = (Object.keys(patch) as (keyof ChatPatch)[])
      .filter((k) => patch[k] !== undefined)
      .map((k) => [PATCH_COLUMNS[k], patch[k]] as const);
    if (columns.length === 0) {
      return;
    }
    this.write(
      () =>
        Number(
          this.db
            .prepare(
              `UPDATE chats SET ${columns.map(([c]) => `${c} = ?`).join(", ")} WHERE id = ?`
            )
            .run(...columns.map(([, v]) => v as string | number), id).changes
        ) > 0
    );
  }

  /** Links a chat to the session its setup just created; `note` becomes its error, else the error is cleared. */
  attachSession(
    id: string,
    session: {
      sessionId: string;
      envId: EnvId;
      directory: string;
      note?: string;
    }
  ): void {
    this.write(() => {
      // A session reconcile adopted before this ran (a claim can't cover a crash) keeps only this chat.
      this.db
        .prepare(
          "DELETE FROM chats WHERE session_id = ? AND id <> ? AND adopted_task IS NULL"
        )
        .run(session.sessionId, id);
      return (
        Number(
          this.db
            .prepare(
              `UPDATE chats SET session_id = ?, env_id = ?, directory = ?, step = 'session', error = ?,
               session_removed_at = NULL WHERE id = ?`
            )
            .run(
              session.sessionId,
              session.envId,
              session.directory,
              session.note ?? null,
              id
            ).changes
        ) > 0
      );
    });
  }

  /** A chat's title follows its session's. */
  setTitle(sessionId: string, title: string): void {
    this.write(
      () =>
        Number(
          this.db
            .prepare(
              "UPDATE chats SET title = ? WHERE session_id = ? AND title <> ?"
            )
            .run(title, sessionId, title).changes
        ) > 0
    );
  }

  /**
   * After a successful listing of `envId`'s sessions: marks its chats' sessions that aren't `listed` removed, and
   * clears the mark on those listed again. Adopted chats are the task's to track.
   */
  markSessionsGone(
    envId: EnvId,
    listed: ReadonlySet<string>,
    actor: Actor = SYSTEM
  ): void {
    const at = this.now();
    const rows = this.db
      .prepare(
        "SELECT * FROM chats WHERE env_id = ? AND session_id IS NOT NULL AND adopted_task IS NULL"
      )
      .all(envId) as unknown as RawChat[];
    const gone = rows.filter(
      (c) => c.session_removed_at === null && !listed.has(c.session_id ?? "")
    );
    const back = rows.filter(
      (c) => c.session_removed_at !== null && listed.has(c.session_id ?? "")
    );
    if (gone.length === 0 && back.length === 0) {
      return;
    }
    this.write(() => {
      for (const c of back) {
        this.db
          .prepare("UPDATE chats SET session_removed_at = NULL WHERE id = ?")
          .run(c.id);
      }
      for (const c of gone) {
        this.db
          .prepare("UPDATE chats SET session_removed_at = ? WHERE id = ?")
          .run(at, c.id);
        this.event(at, actor, "chat.removed", c.project_id, c.id, {
          session: c.session_id,
          title: c.title,
        });
      }
    });
  }

  /** The sessions of `envId`'s chats not marked removed nor adopted. */
  liveSessionsIn(envId: EnvId): string[] {
    return (
      this.db
        .prepare(
          `SELECT session_id FROM chats WHERE env_id = ? AND session_id IS NOT NULL AND session_removed_at IS NULL
           AND adopted_task IS NULL`
        )
        .all(envId) as { session_id: string }[]
    ).map((r) => r.session_id);
  }

  /** Hides a chat from every list; its session is left as it is. False when there is no such chat. */
  archive(id: string, actor: Actor = USER): boolean {
    const at = this.now();
    return this.write(() => {
      const chat = this.raw(id);
      if (!chat) {
        return false;
      }
      if (chat.archived_at !== null) {
        return true;
      }
      this.db
        .prepare("UPDATE chats SET archived_at = ? WHERE id = ?")
        .run(at, id);
      this.event(at, actor, "chat.archived", chat.project_id, id, {
        title: chat.title,
      });
      return true;
    });
  }

  /** Archived chats for cleanup, including chats whose session is already gone. */
  listArchivedForProject(projectId: ProjectId): ChatRecord[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM chats WHERE project_id = ? AND archived_at IS NOT NULL AND adopted_task IS NULL ORDER BY archived_at DESC, id DESC"
        )
        .all(projectId) as unknown as RawChat[]
    ).map(toChat);
  }

  /** Deletes an archived chat record after its conversation has been removed. */
  deleteArchived(
    id: string,
    actor: Actor = USER,
    removedSessionId?: string
  ): boolean {
    const at = this.now();
    return this.write(() => {
      const chat = this.raw(id);
      if (
        !chat ||
        chat.archived_at === null ||
        (chat.session_id &&
          chat.session_removed_at === null &&
          chat.session_id !== removedSessionId)
      ) {
        return false;
      }
      this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
      this.event(at, actor, "chat.deleted", chat.project_id, id, {
        title: chat.title,
      });
      return true;
    });
  }

  /**
   * On start: a chat still being set up lost the job that was setting it up. Marks each failed, and returns how
   * many.
   */
  failInterrupted(): number {
    this.db
      .prepare("UPDATE chats SET error = ? WHERE error = ?")
      .run(FIRST_TURN_INTERRUPTED, FIRST_TURN_SENDING);
    const stuck = (
      this.db
        .prepare(
          "SELECT * FROM chats WHERE session_id IS NULL AND step NOT IN ('failed')"
        )
        .all() as unknown as RawChat[]
    ).filter((c) =>
      settingUp({
        discarded_at: null,
        session_id: c.session_id,
        session_removed_at: null,
        step: c.step,
      })
    );
    if (stuck.length === 0) {
      return 0;
    }
    this.write(() => {
      for (const c of stuck) {
        this.db
          .prepare("UPDATE chats SET step = 'failed', error = ? WHERE id = ?")
          .run(RESTART_ERROR, c.id);
      }
    });
    return stuck.length;
  }

  get(id: string): ChatRecord | undefined {
    const r = this.raw(id);
    return r ? toChat(r) : undefined;
  }

  bySession(sessionId: string): ChatRecord | undefined {
    const r = this.db
      .prepare("SELECT * FROM chats WHERE session_id = ?")
      .get(sessionId) as RawChat | undefined;
    return r ? toChat(r) : undefined;
  }

  /** Whether a session has a chat row, adopted or not; cached until the next change. */
  hasSession(sessionId: string): boolean {
    return this.sessionChat(sessionId) !== undefined;
  }

  /** The chat a session has, adopted or not, with its origin; cached until the next change. */
  sessionChat(
    sessionId: string
  ): { id: string; origin: ChatOrigin; adopted: boolean } | undefined {
    if (!this.sessions) {
      this.sessions = new Map(
        (
          this.db
            .prepare(
              "SELECT id, session_id, origin, adopted_task FROM chats WHERE session_id IS NOT NULL"
            )
            .all() as {
            id: string;
            session_id: string;
            origin: ChatOrigin;
            adopted_task: string | null;
          }[]
        ).map((r) => [
          r.session_id,
          { adopted: r.adopted_task !== null, id: r.id, origin: r.origin },
        ])
      );
    }
    return this.sessions.get(sessionId);
  }

  /** The chat that runs in worktree row `worktreeId` and was made with it, the oldest first. */
  byWorktree(worktreeId: number): ChatRecord | undefined {
    const r = this.db
      .prepare(
        "SELECT * FROM chats WHERE worktree_id = ? ORDER BY created_at, id LIMIT 1"
      )
      .get(worktreeId) as RawChat | undefined;
    return r ? toChat(r) : undefined;
  }

  /** The project's chats the snapshot lists: not internal, archived, removed or adopted; newest first. */
  listForProject(projectId: ProjectId): ChatRecord[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM chats WHERE project_id = ? AND origin <> 'internal' AND archived_at IS NULL
           AND session_removed_at IS NULL AND adopted_task IS NULL ORDER BY created_at DESC, id DESC`
        )
        .all(projectId) as unknown as RawChat[]
    ).map(toChat);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Forgets what is cached, after another store changed chats inside its own transaction. */
  invalidate(): void {
    this.sessions = undefined;
  }

  /** Runs `fn` in a transaction and tells the listeners, unless it returned false (nothing changed). */
  private write<T>(fn: () => T): T {
    const result = transaction(this.db, fn);
    if (result !== false) {
      this.invalidate();
      for (const listener of this.listeners) {
        listener();
      }
    }
    return result;
  }

  private event(
    at: number,
    actor: Actor,
    verb: EventVerb,
    projectId: string,
    chatId: string,
    data?: Record<string, unknown>
  ): void {
    record(this.db, {
      actor,
      at,
      object: { id: chatId, type: "chat" },
      projectId,
      verb,
      ...(data ? { data } : {}),
    });
  }

  private raw(id: string): RawChat | undefined {
    return this.db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as
      | RawChat
      | undefined;
  }
}
