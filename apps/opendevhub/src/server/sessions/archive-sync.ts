import type { EnvId } from "../../shared/types";
import type { ChatStore } from "../db/chats";
import type { TaskStore } from "../db/tasks";
import type { HubDeps } from "../environments/ports";
import type { OpencodeClient, RawSession } from "../opencode/client";
import { atLeast } from "../opencode/runtime";

/** The first opencode whose sessions can be archived over its API. */
export const ARCHIVE_SINCE = "2.1.0";

/** A conversation to archive or unarchive, with its checkout when known. */
export interface SyncedSession {
  sessionId: string;
  directory?: string;
}

export interface ArchiveSyncDeps {
  store: Pick<HubDeps["store"], "runtime">;
  tasks: Pick<TaskStore, "bySession" | "isSessionArchived">;
  chats: Pick<ChatStore, "bySession">;
  /** The environment's opencode; throws when it can't be reached. */
  clientOf: (envId: EnvId) => OpencodeClient;
  log: (envId: EnvId, line: string) => void;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Keeps opencode's archive flag in step with opendevhub's archived chats, tasks and closed task conversations. Best
 * effort: it never throws, skips environments before opencode 2.1 or with a stopped container, and leaves what it
 * missed to `catchUp`. It only follows opendevhub; archiving in opencode never archives anything here.
 */
export class ArchiveSync {
  private readonly deps: ArchiveSyncDeps;
  /** Sessions `catchUp` tried this run, so a failing one isn't retried on every poll. */
  private readonly tried = new Set<string>();
  constructor(deps: ArchiveSyncDeps) {
    this.deps = deps;
  }

  archive(envId: EnvId, sessions: SyncedSession[]): Promise<void> {
    return this.send(envId, sessions, true);
  }

  unarchive(envId: EnvId, sessions: SyncedSession[]): Promise<void> {
    return this.send(envId, sessions, false);
  }

  /** Whether opendevhub has this session archived: an archived chat's or task's, or a closed task conversation. */
  expectsArchived(sessionId: string): boolean {
    const { tasks, chats } = this.deps;
    return (
      tasks.isSessionArchived(sessionId) ||
      tasks.bySession(sessionId)?.task.archivedAt !== undefined ||
      chats.bySession(sessionId)?.archivedAt !== undefined
    );
  }

  /**
   * After a poll: archives listed top-level sessions opendevhub has archived but opencode doesn't, each at most once
   * per run. Never unarchives, so it doesn't fight anyone archiving in opencode's own clients.
   */
  async catchUp(envId: EnvId, sessions: RawSession[]): Promise<void> {
    const missed = sessions.filter(
      (s) =>
        !s.parentID &&
        s.time.archived === undefined &&
        !this.tried.has(s.id) &&
        this.expectsArchived(s.id)
    );
    if (missed.length === 0 || !this.enabled(envId)) {
      return;
    }
    for (const s of missed) {
      this.tried.add(s.id);
    }
    await this.send(
      envId,
      missed.map((s) => ({
        directory: s.location.directory,
        sessionId: s.id,
      })),
      true,
      "caught up: "
    );
  }

  private enabled(envId: EnvId): boolean {
    const rt = this.deps.store.runtime(envId);
    return (
      rt.containerState === "running" &&
      atLeast(rt.opencodeVersion, ARCHIVE_SINCE)
    );
  }

  private async send(
    envId: EnvId,
    sessions: SyncedSession[],
    archived: boolean,
    prefix = ""
  ): Promise<void> {
    if (sessions.length === 0 || !this.enabled(envId)) {
      return;
    }
    const verb = archived ? "archive" : "unarchive";
    let client: OpencodeClient;
    try {
      client = this.deps.clientOf(envId);
    } catch (error) {
      this.deps.log(
        envId,
        `opencode: could not ${verb} sessions: ${message(error)}`
      );
      return;
    }
    await Promise.all(
      sessions.map(async ({ sessionId, directory }) => {
        try {
          await client.setArchived(sessionId, archived, directory);
          if (prefix) {
            this.deps.log(
              envId,
              `opencode: ${prefix}${verb}d session ${sessionId}`
            );
          }
        } catch (error) {
          this.deps.log(
            envId,
            `opencode: could not ${verb} session ${sessionId}: ${message(error)}`
          );
        }
      })
    );
  }
}
