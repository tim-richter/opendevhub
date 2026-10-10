import type { ProjectId } from "./types";

/** What can happen to a record. A verb added here needs a renderer in the web app's activity feed. */
export const EVENT_VERBS = [
  "project.discovered",
  "project.missing",
  "task.started",
  "task.ended",
  "task.archived",
  "variant.failed",
  "variant.picked",
  "variant.discarded",
  "session.started",
  "session.adopted",
  "session.removed",
  "branch.created",
  "branch.published",
  "branch.deleted",
  "worktree.created",
  "worktree.adopted",
  "worktree.switched",
  "worktree.removed",
  "environment.created",
  "environment.removed",
  "ticket.linked",
  "pull_request.linked",
  "review.run",
] as const;

export type EventVerb = (typeof EVENT_VERBS)[number];

export const OBJECT_TYPES = [
  "project",
  "task",
  "variant",
  "session",
  "branch",
  "worktree",
  "environment",
  "ticket",
  "pull_request",
  "review",
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

/** Who caused a change: the user (an API request), a task's setup job for its variant, or opendevhub itself. */
export type Actor =
  | { type: "user" }
  | { type: "system" }
  | { type: "variant"; id: string };

/** One recorded event, with the labels the feed shows it with. */
export interface ActivityEvent {
  id: number;
  at: number;
  actor: Actor;
  verb: EventVerb;
  object: { type: ObjectType; id: string };
  projectId?: ProjectId;
  /** The project's name, while opendevhub knows the project. */
  projectName?: string;
  taskId?: string;
  /** The task's title, while its row exists. */
  taskTitle?: string;
  /** Small: names, URLs, error text. */
  data?: Record<string, unknown>;
}

/** A page of the feed, newest first; `next` is the cursor for the older events, absent on the last page. */
export interface ActivityPage {
  events: ActivityEvent[];
  next?: number;
}

/** What `GET /api/activity` filters by: a project, a task (with its variants' records), or one entity. */
export interface ActivityFilter {
  projectId?: ProjectId;
  taskId?: string;
  entity?: { type: ObjectType; id: string };
}

export const ACTIVITY_PAGE_SIZE = 50;
export const MAX_ACTIVITY_PAGE_SIZE = 200;

/** One entity in a provenance trail, linking to its page when it has one and is still there. */
export interface ProvenanceStep {
  type: ObjectType;
  id: string;
  label: string;
  /** Its page in the dashboard. */
  href?: string;
  /** Its page elsewhere (the forge or Jira), when the dashboard has none. */
  url?: string;
  /** Removed, deleted, discarded or archived; kept so the history stays readable. */
  removed?: boolean;
  /** Found outside opendevhub rather than made by it. */
  unmanaged?: boolean;
}

/** Where an entity came from, outermost origin first and the entity itself last, and what it led to. */
export interface Provenance {
  trail: ProvenanceStep[];
  /** Pull requests and reviews it led to; a ticket's tasks. */
  ledTo: ProvenanceStep[];
}
