import type { Db } from "./database";

/** What can happen to a record. Later changes add verbs for their own records. */
export type EventVerb =
  | "project.discovered"
  | "project.missing"
  | "task.started"
  | "task.ended"
  | "task.archived"
  | "variant.failed"
  | "variant.picked"
  | "variant.discarded"
  | "session.started"
  | "session.adopted"
  | "session.removed"
  | "branch.created"
  | "branch.published"
  | "branch.deleted"
  | "worktree.created"
  | "worktree.adopted"
  | "worktree.switched"
  | "worktree.removed";

export type ObjectType =
  | "project"
  | "task"
  | "variant"
  | "session"
  | "branch"
  | "worktree";

/** Who caused a change: the user (an API request), a task's setup job for its variant, or opendevhub itself. */
export type Actor =
  | { type: "user" }
  | { type: "system" }
  | { type: "variant"; id: string };

export const USER: Actor = { type: "user" };
export const SYSTEM: Actor = { type: "system" };
export const variantActor = (task: string, n: number): Actor => ({
  id: `${task}/${n}`,
  type: "variant",
});

export interface NewEvent {
  at: number;
  projectId?: string;
  actor: Actor;
  verb: EventVerb;
  object: { type: ObjectType; id: string };
  taskId?: string;
  /** Small: names, URLs, error text. */
  data?: Record<string, unknown>;
}

export interface EventRow extends NewEvent {
  id: number;
}

/** Appends an event. Call it inside the transaction that makes the change it records. */
export const record = (db: Db, event: NewEvent): void => {
  db.prepare(
    `INSERT INTO events (at, project_id, actor_type, actor_id, verb, object_type, object_id, task_id, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    event.at,
    event.projectId ?? null,
    event.actor.type,
    event.actor.type === "variant" ? event.actor.id : null,
    event.verb,
    event.object.type,
    event.object.id,
    event.taskId ?? null,
    event.data ? JSON.stringify(event.data) : null
  );
};

interface RawEvent {
  id: number;
  at: number;
  project_id: string | null;
  actor_type: Actor["type"];
  actor_id: string | null;
  verb: EventVerb;
  object_type: ObjectType;
  object_id: string;
  task_id: string | null;
  data: string | null;
}

const toEvent = (r: RawEvent): EventRow => ({
  actor:
    r.actor_type === "variant"
      ? { id: r.actor_id ?? "", type: "variant" }
      : { type: r.actor_type },
  at: r.at,
  id: r.id,
  object: { id: r.object_id, type: r.object_type },
  verb: r.verb,
  ...(r.project_id ? { projectId: r.project_id } : {}),
  ...(r.task_id ? { taskId: r.task_id } : {}),
  ...(r.data ? { data: JSON.parse(r.data) as Record<string, unknown> } : {}),
});

/** Every event after `after`, oldest first. */
export const eventsSince = (db: Db, after = 0): EventRow[] =>
  (
    db
      .prepare("SELECT * FROM events WHERE id > ? ORDER BY id")
      .all(after) as unknown as RawEvent[]
  ).map(toEvent);

/** The id of the newest event, 0 when there is none. */
export const lastEventId = (db: Db): number =>
  (
    db.prepare("SELECT MAX(id) AS id FROM events").get() as {
      id: number | null;
    }
  ).id ?? 0;
