import type { AiFinding } from "../../shared/forgejo";
import type {
  ForgeKind,
  NodeId,
  ProjectId,
  PullLinks,
  PullRequestRef,
  PullRole,
  StoredAiReview,
  TicketLinks,
  TicketRef,
  VariantPullRequest,
} from "../../shared/types";
import { transaction } from "./database";
import type { Db } from "./database";
import { record } from "./events";
import type { Actor } from "./events";
import { taskState } from "./task-state";
import type { VariantState } from "./task-state";

export type PullState = NonNullable<PullRequestRef["state"]>;

/** What is known about a pull request besides its URL: from the forge's API, or from the URL itself. */
export interface PullFacts {
  forge?: ForgeKind;
  owner?: string;
  repo?: string;
  number?: number;
}

/** What fetching a pull request from its forge says about it. */
export interface PullSnapshot {
  title?: string;
  state?: PullState;
  headBranch?: string;
  baseBranch?: string;
}

/** What fetching a ticket from Jira says about it. */
export interface TicketSnapshot {
  title?: string;
  status?: string;
  url?: string;
}

export interface PullRecord extends PullRequestRef {
  id: number;
  headBranch?: string;
  baseBranch?: string;
}

export interface TicketRecord extends TicketRef {
  id: number;
}

export interface NewReview {
  pullRequestId: number;
  /** The review task; defaults to the task of `sessionId`. */
  taskId?: string;
  sessionId?: string;
  mode: "session" | "quick";
  headSha: string;
  summary: string;
  findings: AiFinding[];
}

/** A task's links as the snapshot shows them. */
export interface TaskLinks {
  ticket?: TicketRef;
  pullRequests?: VariantPullRequest[];
  reviewOf?: PullRequestRef;
}

interface RawPull {
  id: number;
  url: string;
  forge: ForgeKind;
  owner: string | null;
  repo: string | null;
  number: number | null;
  title: string | null;
  state: PullState | null;
  head_branch: string | null;
  base_branch: string | null;
  fetched_at: number | null;
}

interface RawTicket {
  id: number;
  instance_url: string;
  key: string;
  url: string;
  title: string | null;
  status: string | null;
  fetched_at: number | null;
}

interface RawReview {
  id: number;
  pull_request_id: number;
  task_id: string | null;
  session_id: string | null;
  mode: "session" | "quick";
  head_sha: string;
  summary: string | null;
  findings: string;
  created_at: number;
}

const PULL_PATHS: { re: RegExp; forge: ForgeKind }[] = [
  {
    forge: "gitlab",
    re: /\/(?<owner>[^/]+(?:\/[^/]+)*)\/(?<repo>[^/]+)\/-\/merge_requests\/(?<n>[1-9]\d*)$/u,
  },
  {
    forge: "forgejo",
    re: /\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pulls\/(?<n>[1-9]\d*)$/u,
  },
  {
    forge: "github",
    re: /\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<n>[1-9]\d*)$/u,
  },
];

/** A pull request's web URL as its key: no fragment and no trailing slash. Throws when it isn't an http(s) URL. */
export const normalisePullUrl = (url: string): string => {
  const u = new URL(url.trim());
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`not a web URL: ${url}`);
  }
  u.hash = "";
  u.username = "";
  u.password = "";
  u.pathname = u.pathname.replace(/\/+$/u, "");
  return u.toString().replace(/\/(?=\?|$)/u, "");
};

/**
 * Owner, repository and number from a Forgejo/Gitea (`/pulls/<n>`), GitHub (`/pull/<n>`) or GitLab
 * (`/-/merge_requests/<n>`) pull request URL; the forge is a guess, since Forgejo and Gitea look alike.
 */
export const parsePullUrl = (
  url: string
):
  | { forge: ForgeKind; owner: string; repo: string; number: number }
  | undefined => {
  let pathname: string;
  try {
    pathname = new URL(url).pathname.replace(/\/+$/u, "");
  } catch {
    return undefined;
  }
  for (const { re, forge } of PULL_PATHS) {
    const g = re.exec(pathname)?.groups;
    if (g?.owner && g.repo && g.n) {
      return {
        forge,
        number: Number(g.n),
        owner: decodeURIComponent(g.owner),
        repo: decodeURIComponent(g.repo),
      };
    }
  }
  return undefined;
};

const toPull = (r: RawPull): PullRecord => ({
  forge: r.forge,
  id: r.id,
  url: r.url,
  ...(r.owner === null ? {} : { owner: r.owner }),
  ...(r.repo === null ? {} : { repo: r.repo }),
  ...(r.number === null ? {} : { number: r.number }),
  ...(r.title === null ? {} : { title: r.title }),
  ...(r.state === null ? {} : { state: r.state }),
  ...(r.head_branch === null ? {} : { headBranch: r.head_branch }),
  ...(r.base_branch === null ? {} : { baseBranch: r.base_branch }),
  ...(r.fetched_at === null ? {} : { fetchedAt: r.fetched_at }),
});

/** A pull request as the client sees it: without the row id and branch names. */
const pullRef = (p: PullRecord): PullRequestRef => {
  const { id: _id, headBranch: _head, baseBranch: _base, ...ref } = p;
  return ref;
};

const toTicket = (r: RawTicket): TicketRecord => ({
  id: r.id,
  instanceUrl: r.instance_url,
  key: r.key,
  url: r.url,
  ...(r.title === null ? {} : { title: r.title }),
  ...(r.status === null ? {} : { status: r.status }),
  ...(r.fetched_at === null ? {} : { fetchedAt: r.fetched_at }),
});

const ticketRef = (t: TicketRecord): TicketRef => {
  const { id: _id, ...ref } = t;
  return ref;
};

const parseFindings = (text: string): AiFinding[] => {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as AiFinding[]) : [];
  } catch {
    return [];
  }
};

const toReview = (r: RawReview): StoredAiReview => ({
  createdAt: r.created_at,
  findings: parseFindings(r.findings),
  headSha: r.head_sha,
  id: r.id,
  mode: r.mode,
  summary: r.summary ?? "",
  ...(r.session_id === null ? {} : { sessionId: r.session_id }),
  ...(r.task_id === null ? {} : { taskId: r.task_id }),
});

const pullByUrl = (db: Db, url: string): PullRecord | undefined => {
  const r = db.prepare("SELECT * FROM pull_requests WHERE url = ?").get(url) as
    | RawPull
    | undefined;
  return r ? toPull(r) : undefined;
};

const ticketByKey = (
  db: Db,
  instanceUrl: string,
  key: string
): TicketRecord | undefined => {
  const r = db
    .prepare("SELECT * FROM tickets WHERE instance_url = ? AND key = ?")
    .get(instanceUrl, key) as RawTicket | undefined;
  return r ? toTicket(r) : undefined;
};

/** A Jira instance URL as the ticket key's other half: no trailing slash. */
const instanceKey = (instanceUrl: string): string =>
  instanceUrl.trim().replace(/\/+$/u, "");

/**
 * The pull request row for `url`, inserted when it has none. Call it inside a transaction. Owner, repository and
 * number come from `facts` or else the URL; a row's known forge is kept over a guess.
 */
export const ensurePullIn = (
  db: Db,
  url: string,
  facts: PullFacts = {}
): PullRecord => {
  const key = normalisePullUrl(url);
  const parsed = parsePullUrl(key);
  const forge = facts.forge ?? parsed?.forge ?? "unknown";
  db.prepare(
    `INSERT INTO pull_requests (url, forge, owner, repo, number) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (url) DO UPDATE SET
       forge = CASE WHEN ? THEN excluded.forge ELSE forge END,
       owner = COALESCE(owner, excluded.owner),
       repo = COALESCE(repo, excluded.repo),
       number = COALESCE(number, excluded.number)`
  ).run(
    key,
    forge,
    facts.owner ?? parsed?.owner ?? null,
    facts.repo ?? parsed?.repo ?? null,
    facts.number ?? parsed?.number ?? null,
    facts.forge ? 1 : 0
  );
  const row = pullByUrl(db, key);
  if (!row) {
    throw new Error(`pull request ${key} vanished after insert`);
  }
  return row;
};

/** The ticket row for (instance, key), inserted when it has none. Call it inside a transaction. */
export const ensureTicketIn = (
  db: Db,
  ticket: { instanceUrl: string; key: string; url: string; title?: string }
): TicketRecord => {
  const instance = instanceKey(ticket.instanceUrl);
  db.prepare(
    `INSERT INTO tickets (instance_url, key, url, title) VALUES (?, ?, ?, ?)
     ON CONFLICT (instance_url, key) DO UPDATE SET title = COALESCE(title, excluded.title)`
  ).run(instance, ticket.key, ticket.url, ticket.title ?? null);
  const row = ticketByKey(db, instance, ticket.key);
  if (!row) {
    throw new Error(`ticket ${ticket.key} vanished after insert`);
  }
  return row;
};

/**
 * Points branch `branchId` at pull request `pullId` with `role`, and records `pull_request.linked`. Call it inside
 * a transaction. False when the branch already had that link.
 */
export const linkBranchIn = (
  db: Db,
  at: number,
  actor: Actor,
  branchId: number,
  pullId: number,
  role: PullRole
): boolean => {
  const branch = db
    .prepare(
      "SELECT project_id, name, created_by_task, pull_request_id, pr_role FROM branches WHERE id = ?"
    )
    .get(branchId) as
    | {
        project_id: string;
        name: string;
        created_by_task: string | null;
        pull_request_id: number | null;
        pr_role: PullRole | null;
      }
    | undefined;
  if (!branch) {
    throw new Error(`no branch ${branchId}`);
  }
  if (branch.pull_request_id === pullId && branch.pr_role === role) {
    return false;
  }
  db.prepare(
    "UPDATE branches SET pull_request_id = ?, pr_role = ? WHERE id = ?"
  ).run(pullId, role, branchId);
  const url = (
    db.prepare("SELECT url FROM pull_requests WHERE id = ?").get(pullId) as
      | { url: string }
      | undefined
  )?.url;
  record(db, {
    actor,
    at,
    data: { branch: branch.name, role, ...(url ? { url } : {}) },
    object: { id: String(pullId), type: "pull_request" },
    projectId: branch.project_id,
    verb: "pull_request.linked",
    ...(branch.created_by_task ? { taskId: branch.created_by_task } : {}),
  });
  return true;
};

/** Records that task `taskId` was started from `ticket`. Call it inside the transaction that creates the task. */
export const linkTicketIn = (
  db: Db,
  at: number,
  actor: Actor,
  projectId: ProjectId,
  taskId: string,
  ticket: TicketRecord
): void => {
  db.prepare("UPDATE tasks SET ticket_id = ? WHERE id = ?").run(
    ticket.id,
    taskId
  );
  record(db, {
    actor,
    at,
    data: { key: ticket.key, url: ticket.url },
    object: { id: String(ticket.id), type: "ticket" },
    projectId,
    taskId,
    verb: "ticket.linked",
  });
};

const PULLS_OF_VARIANTS = `SELECT v.task_id AS task_id, v.n AS variant, p.*
  FROM variants v
  JOIN branches b ON b.id = v.branch_id
  JOIN pull_requests p ON p.id = b.pull_request_id
  WHERE b.pr_role = 'head'`;

type RawVariantPull = RawPull & { task_id: string; variant: number };

const variantPull = (r: RawVariantPull): VariantPullRequest => {
  const { task_id: _task, variant, ...pull } = r;
  return { ...pullRef(toPull(pull)), variant };
};

const groupBy = <T, K>(items: readonly T[], key: (t: T) => K): Map<K, T[]> => {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) {
      list.push(item);
    } else {
      out.set(k, [item]);
    }
  }
  return out;
};

/**
 * Tickets, pull requests and AI reviews, and what links them to tasks and branches. Link and review writes record
 * their events in the same transaction; refreshing a snapshot records none. `subscribe` hears about each change.
 */
export class LinkStore {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();

  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** The ticket row for (instance, key), inserted when it has none. */
  ensureTicket(ticket: {
    instanceUrl: string;
    key: string;
    url: string;
    title?: string;
  }): TicketRecord {
    return this.write(() => ensureTicketIn(this.db, ticket));
  }

  /** Updates a known ticket's title and status from Jira. False when opendevhub has no row for it. */
  refreshTicket(
    instanceUrl: string,
    key: string,
    snapshot: TicketSnapshot
  ): boolean {
    return this.refreshTickets([{ instanceUrl, key, ...snapshot }]) > 0;
  }

  /** Updates the known ones among tickets Jira just listed, in one transaction. Returns how many it knew. */
  refreshTickets(
    list: readonly ({ instanceUrl: string; key: string } & TicketSnapshot)[]
  ): number {
    const at = this.now();
    const known = list.filter((t) =>
      ticketByKey(this.db, instanceKey(t.instanceUrl), t.key)
    );
    if (known.length === 0) {
      return 0;
    }
    return this.write(() => {
      const update = this.db.prepare(
        `UPDATE tickets SET title = COALESCE(?, title), status = COALESCE(?, status), url = COALESCE(?, url),
         fetched_at = ? WHERE instance_url = ? AND key = ?`
      );
      for (const t of known) {
        update.run(
          t.title ?? null,
          t.status ?? null,
          t.url ?? null,
          at,
          instanceKey(t.instanceUrl),
          t.key
        );
      }
      return known.length;
    });
  }

  /** The pull request row for `url`, inserted when it has none. */
  ensurePull(url: string, facts: PullFacts = {}): PullRecord {
    return this.write(() => ensurePullIn(this.db, url, facts));
  }

  /** Updates a known pull request's snapshot from its forge. False when opendevhub has no row for it. */
  refreshPull(url: string, snapshot: PullSnapshot & PullFacts): boolean {
    return this.refreshPulls([{ url, ...snapshot }]) > 0;
  }

  /** Updates the known ones among pull requests the forge just listed, in one transaction. Returns how many it knew. */
  refreshPulls(
    list: readonly ({ url: string } & PullSnapshot & PullFacts)[]
  ): number {
    const at = this.now();
    const known = list.flatMap((p) => {
      const row = this.pull(p.url);
      return row ? [{ ...p, url: row.url }] : [];
    });
    if (known.length === 0) {
      return 0;
    }
    return this.write(() => {
      const update = this.db.prepare(
        `UPDATE pull_requests SET title = COALESCE(?, title), state = COALESCE(?, state),
         head_branch = COALESCE(?, head_branch), base_branch = COALESCE(?, base_branch),
         owner = COALESCE(?, owner), repo = COALESCE(?, repo), number = COALESCE(?, number),
         forge = COALESCE(?, forge), fetched_at = ? WHERE url = ?`
      );
      for (const p of known) {
        update.run(
          p.title ?? null,
          p.state ?? null,
          p.headBranch ?? null,
          p.baseBranch ?? null,
          p.owner ?? null,
          p.repo ?? null,
          p.number ?? null,
          p.forge ?? null,
          at,
          p.url
        );
      }
      return known.length;
    });
  }

  /** Points a branch at a pull request; records `pull_request.linked` when the link is new. */
  linkBranch(
    branchId: number,
    pullId: number,
    role: PullRole,
    actor: Actor
  ): boolean {
    const at = this.now();
    return this.write(() =>
      linkBranchIn(this.db, at, actor, branchId, pullId, role)
    );
  }

  /** Stores an AI review run and records `review.run`. */
  insertReview(input: NewReview, actor: Actor): StoredAiReview {
    const at = this.now();
    return this.write(() => {
      const taskId =
        input.taskId ??
        (input.sessionId
          ? (
              this.db
                .prepare("SELECT task_id FROM variants WHERE session_id = ?")
                .get(input.sessionId) as { task_id: string } | undefined
            )?.task_id
          : undefined);
      const review = { ...input, ...(taskId ? { taskId } : {}) };
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO reviews (pull_request_id, task_id, session_id, mode, head_sha, summary, findings, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            review.pullRequestId,
            review.taskId ?? null,
            review.sessionId ?? null,
            review.mode,
            review.headSha,
            review.summary,
            JSON.stringify(review.findings),
            at
          ).lastInsertRowid
      );
      const meta = this.db
        .prepare(
          `SELECT p.url AS url, t.project_id AS project_id FROM pull_requests p
           LEFT JOIN tasks t ON t.id = ? WHERE p.id = ?`
        )
        .get(review.taskId ?? null, review.pullRequestId) as
        | { url: string; project_id: string | null }
        | undefined;
      record(this.db, {
        actor,
        at,
        data: {
          findings: review.findings.length,
          headSha: review.headSha,
          mode: review.mode,
          ...(meta ? { url: meta.url } : {}),
        },
        object: { id: String(id), type: "review" },
        verb: "review.run",
        ...(meta?.project_id ? { projectId: meta.project_id } : {}),
        ...(review.taskId ? { taskId: review.taskId } : {}),
      });
      const row = this.db
        .prepare("SELECT * FROM reviews WHERE id = ?")
        .get(id) as unknown as RawReview;
      return toReview(row);
    });
  }

  /** A pull request's stored reviews, newest first; none for a URL without a row. */
  reviewsOf(url: string): StoredAiReview[] {
    const pull = this.pull(url);
    return pull ? this.reviewsById(pull.id) : [];
  }

  /** The pull request row for `url`, when there is one. */
  pull(url: string): PullRecord | undefined {
    try {
      return pullByUrl(this.db, normalisePullUrl(url));
    } catch {
      return undefined;
    }
  }

  /** The ticket row for (instance, key), when there is one. */
  ticket(instanceUrl: string, key: string): TicketRecord | undefined {
    return ticketByKey(this.db, instanceKey(instanceUrl), key);
  }

  /** Everything linked to a pull request: branches with their worktrees and creating tasks, review tasks, reviews. */
  forPull(url: string): PullLinks {
    const pull = this.pull(url);
    if (!pull) {
      return { branches: [], reviewTasks: [], reviews: [] };
    }
    const branches = this.db
      .prepare(
        `SELECT b.id, b.project_id, b.name, b.pr_role, b.deleted_at, b.created_by, b.created_by_task,
           b.created_by_variant, t.title AS task_title
         FROM branches b LEFT JOIN tasks t ON t.id = b.created_by_task
         WHERE b.pull_request_id = ? ORDER BY b.created_at DESC, b.id DESC`
      )
      .all(pull.id) as unknown as {
      id: number;
      project_id: string;
      name: string;
      pr_role: PullRole;
      deleted_at: number | null;
      created_by: string;
      created_by_task: string | null;
      created_by_variant: number | null;
      task_title: string | null;
    }[];
    const worktrees = groupBy(
      this.db
        .prepare(
          `SELECT w.branch_id, w.path, w.node_id, w.removed_at FROM worktrees w
           JOIN branches b ON b.id = w.branch_id WHERE b.pull_request_id = ? ORDER BY w.id DESC`
        )
        .all(pull.id) as unknown as {
        branch_id: number;
        path: string;
        node_id: NodeId | null;
        removed_at: number | null;
      }[],
      (w) => w.branch_id
    );
    const reviewTasks = this.db
      .prepare(
        "SELECT id, project_id, title, created_at FROM tasks WHERE pull_request_id = ? ORDER BY created_at DESC, id DESC"
      )
      .all(pull.id) as unknown as {
      id: string;
      project_id: string;
      title: string;
      created_at: number;
    }[];
    return {
      branches: branches.map((b) => ({
        id: b.id,
        name: b.name,
        projectId: b.project_id,
        role: b.pr_role,
        worktrees: (worktrees.get(b.id) ?? []).map((w) => ({
          path: w.path,
          ...(w.node_id === null ? {} : { node: w.node_id }),
          ...(w.removed_at === null ? {} : { removed: true }),
        })),
        ...(b.deleted_at === null ? {} : { deleted: true }),
        ...(b.created_by === "variant" &&
        b.created_by_task !== null &&
        b.created_by_variant !== null
          ? {
              task: {
                id: b.created_by_task,
                n: b.created_by_variant,
                title: b.task_title ?? "",
              },
            }
          : {}),
      })),
      pull: pullRef(pull),
      reviewTasks: reviewTasks.map((t) => ({
        createdAt: t.created_at,
        id: t.id,
        projectId: t.project_id,
        title: t.title,
      })),
      reviews: this.reviewsById(pull.id),
    };
  }

  /** The tasks started from a ticket, archived ones included, with their variants' pull requests. */
  forTicket(instanceUrl: string, key: string): TicketLinks {
    const ticket = this.ticket(instanceUrl, key);
    if (!ticket) {
      return { tasks: [] };
    }
    const tasks = this.db
      .prepare(
        "SELECT id, project_id, title, created_at, archived_at FROM tasks WHERE ticket_id = ? ORDER BY created_at DESC, id DESC"
      )
      .all(ticket.id) as unknown as {
      id: string;
      project_id: string;
      title: string;
      created_at: number;
      archived_at: number | null;
    }[];
    const variants = groupBy(
      this.db
        .prepare(
          `SELECT v.* FROM variants v JOIN tasks t ON t.id = v.task_id WHERE t.ticket_id = ? ORDER BY v.task_id, v.n`
        )
        .all(ticket.id) as unknown as (VariantState & { task_id: string })[],
      (v) => v.task_id
    );
    const pulls = groupBy(
      this.db
        .prepare(
          `${PULLS_OF_VARIANTS} AND v.task_id IN (SELECT id FROM tasks WHERE ticket_id = ?) ORDER BY v.task_id, v.n`
        )
        .all(ticket.id) as unknown as RawVariantPull[],
      (r) => r.task_id
    );
    return {
      tasks: tasks.map((t) => ({
        createdAt: t.created_at,
        id: t.id,
        projectId: t.project_id,
        pullRequests: (pulls.get(t.id) ?? []).map(variantPull),
        state: taskState(variants.get(t.id) ?? []),
        title: t.title,
        ...(t.archived_at === null ? {} : { archived: true }),
      })),
      ticket: ticketRef(ticket),
    };
  }

  /** The ticket, pull requests and reviewed pull request of each of the project's tasks that has any. */
  taskLinks(projectId: ProjectId): Map<string, TaskLinks> {
    const out = new Map<string, TaskLinks>();
    const entry = (task: string): TaskLinks => {
      let links = out.get(task);
      if (!links) {
        links = {};
        out.set(task, links);
      }
      return links;
    };
    const tickets = this.db
      .prepare(
        `SELECT t.id AS task_id, k.* FROM tasks t JOIN tickets k ON k.id = t.ticket_id
         WHERE t.project_id = ? AND t.archived_at IS NULL`
      )
      .all(projectId) as unknown as (RawTicket & { task_id: string })[];
    for (const { task_id: task, ...ticket } of tickets) {
      entry(task).ticket = ticketRef(toTicket(ticket));
    }
    const pulls = this.db
      .prepare(
        `${PULLS_OF_VARIANTS} AND v.task_id IN (SELECT id FROM tasks WHERE project_id = ? AND archived_at IS NULL)
         ORDER BY v.task_id, v.n`
      )
      .all(projectId) as unknown as RawVariantPull[];
    for (const r of pulls) {
      const links = entry(r.task_id);
      links.pullRequests = [...(links.pullRequests ?? []), variantPull(r)];
    }
    const reviewed = this.db
      .prepare(
        `SELECT t.id AS task_id, p.* FROM tasks t JOIN pull_requests p ON p.id = t.pull_request_id
         WHERE t.project_id = ? AND t.archived_at IS NULL`
      )
      .all(projectId) as unknown as (RawPull & { task_id: string })[];
    for (const { task_id: task, ...pull } of reviewed) {
      entry(task).reviewOf = pullRef(toPull(pull));
    }
    return out;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private reviewsById(pullId: number): StoredAiReview[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM reviews WHERE pull_request_id = ? ORDER BY created_at DESC, id DESC"
        )
        .all(pullId) as unknown as RawReview[]
    ).map(toReview);
  }

  /** Runs `fn` in a transaction and tells the listeners, unless it returned false (nothing changed). */
  private write<T>(fn: () => T): T {
    const result = transaction(this.db, fn);
    if (result !== false) {
      for (const listener of this.listeners) {
        listener();
      }
    }
    return result;
  }
}
