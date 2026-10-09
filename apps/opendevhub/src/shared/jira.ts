export type {
  IntegrationSettings as JiraSettings,
  IntegrationSettingsInput as JiraSettingsInput,
} from "./integrations";

/** Jira's fixed status categories: to do, in progress and done. */
export const JIRA_STATUS_CATEGORIES = ["new", "indeterminate", "done"] as const;
export type JiraStatusCategory = (typeof JIRA_STATUS_CATEGORIES)[number];

export interface JiraTicketSummary {
  key: string;
  title: string;
  url: string;
  status: string;
  statusId?: string;
  statusCategory?: JiraStatusCategory;
  type: string;
  priority?: string;
  assignee?: string;
  updatedAt: string;
}

export interface JiraTicket extends JiraTicketSummary {
  instanceUrl: string;
  description: string;
  project: string;
  reporter?: string;
  labels: string[];
  createdAt: string;
}

/** Which tickets to list before the project, status and text filters narrow them down. */
export const JIRA_SCOPES = [
  "assigned",
  "reported",
  "watching",
  "all",
  "board",
  "filter",
] as const;
export type JiraScope = (typeof JIRA_SCOPES)[number];
/** Jira's status categories, plus "open" (anything not done) and "any". */
export const JIRA_STATUSES = [
  "open",
  "todo",
  "progress",
  "done",
  "any",
] as const;
export type JiraStatusFilter = (typeof JIRA_STATUSES)[number];
export const JIRA_SORTS = ["updated", "created", "priority", "rank"] as const;
export type JiraSort = (typeof JIRA_SORTS)[number];

export interface JiraTicketQuery {
  scope: JiraScope;
  /** Agile board id, required for the "board" scope. */
  board?: number;
  /** Only issues in the board's open sprints (scrum boards). */
  sprint?: boolean;
  /** Saved filter id, required for the "filter" scope. */
  filter?: number;
  project?: string;
  status: JiraStatusFilter;
  sort: JiraSort;
  search: string;
  startAt: number;
}

export const JIRA_DEFAULT_QUERY: JiraTicketQuery = {
  scope: "assigned",
  search: "",
  sort: "updated",
  startAt: 0,
  status: "any",
};

export const JIRA_PROJECT_KEY = /^[A-Z][A-Z0-9_]*$/u;
const ID = /^[1-9]\d{0,14}$/u;
const OFFSET = /^(?:0|[1-9]\d{0,14})$/u;

const oneOf = <T extends string>(
  values: readonly T[],
  raw: string | null,
  fallback: T
): T | undefined => {
  if (raw === null) {
    return fallback;
  }
  return values.find((v) => v === raw);
};

/**
 * Reads a ticket query from URL parameters (the Tickets page URL and the API share them).
 * Returns undefined when any parameter is malformed or a scope lacks its board or filter.
 */
export const parseJiraQuery = (
  params: URLSearchParams
): JiraTicketQuery | undefined => {
  const d = JIRA_DEFAULT_QUERY;
  const scope = oneOf(JIRA_SCOPES, params.get("scope"), d.scope);
  const status = oneOf(JIRA_STATUSES, params.get("status"), d.status);
  const sort = oneOf(JIRA_SORTS, params.get("sort"), d.sort);
  const startAt = params.get("startAt") ?? "0";
  const board = params.get("board");
  const filter = params.get("filter");
  const project = params.get("project");
  const sprint = params.get("sprint");
  if (
    !scope ||
    !status ||
    !sort ||
    !OFFSET.test(startAt) ||
    (board !== null && !ID.test(board)) ||
    (filter !== null && !ID.test(filter)) ||
    (project !== null && !JIRA_PROJECT_KEY.test(project)) ||
    (sprint !== null && sprint !== "1") ||
    (scope === "board") !== (board !== null) ||
    (scope === "filter") !== (filter !== null) ||
    (sprint !== null && scope !== "board")
  ) {
    return undefined;
  }
  return {
    scope,
    search: params.get("search") ?? "",
    sort,
    startAt: Number(startAt),
    status,
    ...(board === null ? {} : { board: Number(board) }),
    ...(filter === null ? {} : { filter: Number(filter) }),
    ...(project === null ? {} : { project }),
    ...(sprint === null ? {} : { sprint: true }),
  };
};

/** URL parameters for a query, leaving out defaults so URLs stay short. */
export const jiraQueryParams = (
  query: Partial<JiraTicketQuery>
): URLSearchParams => {
  const params = new URLSearchParams();
  const d = JIRA_DEFAULT_QUERY;
  const { scope, board, sprint, filter, project, status, sort, search } = query;
  if (scope && scope !== d.scope) {
    params.set("scope", scope);
  }
  if (scope === "board" && board !== undefined) {
    params.set("board", String(board));
    if (sprint) {
      params.set("sprint", "1");
    }
  }
  if (scope === "filter" && filter !== undefined) {
    params.set("filter", String(filter));
  }
  if (project) {
    params.set("project", project);
  }
  if (status && status !== d.status) {
    params.set("status", status);
  }
  if (sort && sort !== d.sort) {
    params.set("sort", sort);
  }
  if (search) {
    params.set("search", search);
  }
  if (query.startAt) {
    params.set("startAt", String(query.startAt));
  }
  return params;
};

export interface JiraBoard {
  id: number;
  name: string;
  type: string;
  project?: string;
}

export interface JiraFilter {
  id: number;
  name: string;
}

export interface JiraProject {
  key: string;
  name: string;
}

/** The pickers for the Tickets page: boards, favourite filters and projects visible to the token. */
export interface JiraCatalog {
  boards: JiraBoard[];
  filters: JiraFilter[];
  projects: JiraProject[];
}

/** A column of an agile board and the statuses that land in it, in board order. */
export interface JiraBoardColumn {
  name: string;
  statusIds: string[];
}

export interface JiraKanbanColumn {
  name: string;
  tickets: JiraTicketSummary[];
}

/** Columns end with "Done" so unknown categories sort between "new" and "done". */
const categoryOrder = (category?: JiraStatusCategory): number =>
  category ? JIRA_STATUS_CATEGORIES.indexOf(category) : 1;

/**
 * Groups tickets into kanban columns, keeping each column in list order. With a board's
 * columns, tickets land in the column mapping their status, every configured column shows
 * even when empty, and statuses the board leaves unmapped collect in a trailing "Other".
 * Without them, every status is a column, ordered by status category.
 */
export const jiraKanban = (
  tickets: JiraTicketSummary[],
  board?: JiraBoardColumn[]
): JiraKanbanColumn[] => {
  if (board?.length) {
    const columns = board.map((c) => ({
      name: c.name,
      tickets: [] as JiraTicketSummary[],
    }));
    const byStatus = new Map<string, JiraKanbanColumn>();
    for (const [i, c] of board.entries()) {
      for (const id of c.statusIds) {
        byStatus.set(id, columns[i]);
      }
    }
    const other: JiraKanbanColumn = { name: "Other", tickets: [] };
    for (const ticket of tickets) {
      const column = ticket.statusId
        ? byStatus.get(ticket.statusId)
        : undefined;
      (column ?? other).tickets.push(ticket);
    }
    return other.tickets.length ? [...columns, other] : columns;
  }
  const columns = new Map<
    string,
    JiraKanbanColumn & { category?: JiraStatusCategory }
  >();
  for (const ticket of tickets) {
    const column = columns.get(ticket.status) ?? {
      category: ticket.statusCategory,
      name: ticket.status,
      tickets: [],
    };
    column.tickets.push(ticket);
    columns.set(ticket.status, column);
  }
  return [...columns.values()]
    .map((column, index) => ({ column, index }))
    .toSorted(
      (a, b) =>
        categoryOrder(a.column.category) - categoryOrder(b.column.category) ||
        a.index - b.index
    )
    .map(({ column: { name, tickets: items } }) => ({ name, tickets: items }));
};

export interface JiraTickets {
  tickets: JiraTicketSummary[];
  total: number;
  nextStartAt?: number;
}

/** A durable snapshot of the ticket used to create a task, stored in session metadata. */
export interface JiraTaskSource {
  key: string;
  instanceUrl: string;
  title: string;
  description: string;
}

export const JIRA_KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/u;

export const jiraTicketUrl = (
  ticket: Pick<JiraTaskSource, "instanceUrl" | "key">
): string => `${ticket.instanceUrl}/browse/${encodeURIComponent(ticket.key)}`;

export const jiraTaskPrompt = (ticket: JiraTaskSource): string =>
  `Implement ${ticket.key}: ${ticket.title}\n\nTicket: ${jiraTicketUrl(ticket)}\n\n${ticket.description || "No description provided."}`;
