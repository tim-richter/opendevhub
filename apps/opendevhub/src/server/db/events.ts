import type {
  ActivityEvent,
  ActivityFilter,
  ActivityPage,
  Actor,
  EventVerb,
  ObjectType,
} from "../../shared/activity";
import { ACTIVITY_PAGE_SIZE } from "../../shared/activity";
import type { Db } from "./database";

export type { Actor, EventVerb, ObjectType } from "../../shared/activity";

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

/** Events are kept this long; older ones are deleted at startup. */
export const EVENT_RETENTION_MS = 180 * 24 * 60 * 60_000;
const PRUNE_BATCH = 1000;

/**
 * A page of events matching `filter`, newest first, older than event `before` when given. Keyset-paged by id, so
 * events recorded meanwhile never shift a page. Each event carries its project's name and its task's title.
 */
export const page = (
  db: Db,
  filter: ActivityFilter = {},
  before?: number,
  limit = ACTIVITY_PAGE_SIZE
): ActivityPage => {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.projectId !== undefined) {
    where.push("e.project_id = ?");
    args.push(filter.projectId);
  }
  if (filter.taskId !== undefined) {
    where.push("e.task_id = ?");
    args.push(filter.taskId);
  }
  if (filter.entity) {
    where.push("e.object_type = ? AND e.object_id = ?");
    args.push(filter.entity.type, filter.entity.id);
  }
  if (before !== undefined) {
    where.push("e.id < ?");
    args.push(before);
  }
  const rows = db
    .prepare(
      `SELECT e.*, p.name AS project_name, t.title AS task_title FROM events e
       LEFT JOIN projects p ON p.id = e.project_id
       LEFT JOIN tasks t ON t.id = e.task_id
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY e.id DESC LIMIT ?`
    )
    .all(...args, limit + 1) as unknown as (RawEvent & {
    project_name: string | null;
    task_title: string | null;
  })[];
  const more = rows.length > limit;
  const events = rows.slice(0, limit).map((r): ActivityEvent => ({
    ...toEvent(r),
    ...(r.project_name === null ? {} : { projectName: r.project_name }),
    ...(r.task_title === null ? {} : { taskTitle: r.task_title }),
  }));
  const last = events.at(-1);
  return { events, ...(more && last ? { next: last.id } : {}) };
};

/** Deletes the events recorded before `olderThan`, a batch at a time so no one transaction grows large. */
export const prune = (
  db: Db,
  olderThan: number,
  batch = PRUNE_BATCH
): number => {
  const remove = db.prepare(
    "DELETE FROM events WHERE id IN (SELECT id FROM events WHERE at < ? ORDER BY id LIMIT ?)"
  );
  let total = 0;
  for (;;) {
    const { changes } = remove.run(olderThan, batch);
    total += Number(changes);
    if (Number(changes) < batch) {
      return total;
    }
  }
};

/** The event log as the API and the snapshot read it. Writes go through `record` inside each repository's change. */
export class EventStore {
  private readonly db: Db;
  private readonly now: () => number;

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  page(
    filter: ActivityFilter = {},
    before?: number,
    limit?: number
  ): ActivityPage {
    return page(this.db, filter, before, limit);
  }

  latestId(): number {
    return lastEventId(this.db);
  }

  /** Deletes events past retention; returns how many. */
  pruneOld(): number {
    return prune(this.db, this.now() - EVENT_RETENTION_MS);
  }
}
