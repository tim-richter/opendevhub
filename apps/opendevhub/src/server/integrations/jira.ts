import {
  JIRA_DEFAULT_QUERY,
  JIRA_KEY,
  JIRA_PROJECT_KEY,
  JIRA_SCOPES,
  JIRA_SORTS,
  JIRA_STATUS_CATEGORIES,
  JIRA_STATUSES,
} from "../../shared/jira";
import type {
  JiraBoard,
  JiraBoardColumn,
  JiraCatalog,
  JiraFilter,
  JiraProject,
  JiraScope,
  JiraSettings,
  JiraSort,
  JiraStatusFilter,
  JiraTicketQuery,
  JiraTicket,
  JiraTicketSummary,
  JiraTickets,
} from "../../shared/jira";
import { jiraToMarkdown } from "./jira-markup";
import { OsSecretStore } from "./secrets";
import type { SecretStore } from "./secrets";
import {
  FileIntegrationSettings,
  IntegrationError,
  integrationUrl,
} from "./settings";

export class JiraError extends IntegrationError {
  constructor(message: string, status: 400 | 404 | 412 | 502 = 400) {
    super(message, status);
    this.name = "JiraError";
  }
}

export const jiraUrl = (raw: string): string =>
  integrationUrl(raw, "Jira", JiraError);

export class FileJiraSettings extends FileIntegrationSettings {
  constructor(
    configDir: string,
    secrets: SecretStore = new OsSecretStore("opendevhub.jira")
  ) {
    super(configDir, "Jira", jiraUrl, JiraError, secrets);
  }
}

interface Connection {
  url: string;
  token: string;
}
interface Issue {
  key: string;
  fields: {
    summary: string;
    description?: string | null;
    status: {
      id?: unknown;
      name: string;
      statusCategory?: { key?: unknown } | null;
    };
    issuetype: { name: string };
    priority?: { name: string } | null;
    assignee?: { displayName: string } | null;
    reporter?: { displayName: string } | null;
    project?: { name: string };
    labels?: string[];
    created?: string;
    updated: string;
  };
}

const FIELDS = "summary,status,issuetype,priority,assignee,updated";
const PAGE_SIZE = 50;
/** Stop listing boards after this many pages so a huge instance cannot stall the picker. */
const BOARD_PAGES = 10;
const CATALOG_LIMIT = 2000;

const SCOPE_JQL: Record<Exclude<JiraScope, "filter">, string> = {
  all: "",
  assigned: "assignee = currentUser()",
  // The board's own filter scopes its issue endpoint.
  board: "",
  reported: "reporter = currentUser()",
  watching: "watcher = currentUser()",
};
const STATUS_JQL: Record<JiraStatusFilter, string> = {
  any: "",
  done: "statusCategory = done",
  open: "statusCategory != done",
  progress: "statusCategory = indeterminate",
  todo: "statusCategory = new",
};
const ORDER_JQL: Record<JiraSort, string> = {
  created: "created DESC",
  priority: "priority DESC, updated DESC",
  rank: "Rank ASC",
  updated: "updated DESC",
};

const isId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0;

const validQuery = (query: JiraTicketQuery): boolean =>
  JIRA_SCOPES.includes(query.scope) &&
  JIRA_STATUSES.includes(query.status) &&
  JIRA_SORTS.includes(query.sort) &&
  typeof query.search === "string" &&
  query.search.length <= 500 &&
  !/[\u0000-\u001F]/u.test(query.search) &&
  Number.isSafeInteger(query.startAt) &&
  query.startAt >= 0 &&
  (query.scope === "board" ? isId(query.board) : query.board === undefined) &&
  (query.scope === "filter"
    ? isId(query.filter)
    : query.filter === undefined) &&
  (query.project === undefined ||
    (typeof query.project === "string" &&
      query.project.length <= 100 &&
      JIRA_PROJECT_KEY.test(query.project)));

/** The JQL for a query; text is escaped for both Lucene and JQL, never accepted as JQL. */
export const ticketJql = (query: JiraTicketQuery): string => {
  const term = query.search.trim();
  if (JIRA_KEY.test(term.toUpperCase())) {
    // An exact key finds the ticket wherever it lives.
    return `key = ${JSON.stringify(term.toUpperCase())}`;
  }
  const clauses = [
    query.scope === "filter"
      ? `filter = ${query.filter}`
      : SCOPE_JQL[query.scope],
    query.scope === "board" && query.sprint ? "sprint in openSprints()" : "",
    query.project ? `project = ${JSON.stringify(query.project)}` : "",
    STATUS_JQL[query.status],
    term
      ? `text ~ ${JSON.stringify(`"${term.replaceAll(/[+\-&|!(){}[\]^"~*?:\\/]/gu, "\\$&")}"`)}`
      : "",
  ].filter(Boolean);
  const where = clauses.join(" AND ");
  return `${where ? `${where} ` : ""}ORDER BY ${ORDER_JQL[query.sort]}`;
};

/** Jira Server/Data Center REST v2 with a personal access token (Bearer authentication). */
export class Jira {
  private readonly settings: FileJiraSettings;
  private readonly fetcher: typeof fetch;
  constructor(settings: FileJiraSettings, fetcher: typeof fetch = fetch) {
    this.settings = settings;
    this.fetcher = fetcher;
  }

  view(): Promise<JiraSettings> {
    return this.settings.view();
  }
  save(input: Record<string, unknown>): Promise<JiraSettings> {
    return this.settings.save(input);
  }

  private async connection(): Promise<Connection> {
    const result2 = await this.view();
    if (!result2.enabled) {
      throw new JiraError("Enable Jira in Settings first.", 412);
    }
    const settings = await this.settings.read();
    if (!settings.enabled || !settings.url) {
      throw new JiraError("Enable Jira in Settings first.", 412);
    }
    if (!settings.token) {
      throw new JiraError(
        "The saved Jira token is missing from the OS credential store. Enter a new token in Settings.",
        412
      );
    }
    return { token: settings.token, url: settings.url };
  }

  /** GETs `route` relative to the instance, e.g. `rest/api/2/search?…`. */
  private async json<T>(connection: Connection, route: string): Promise<T> {
    try {
      const response = await this.fetcher(`${connection.url}/${route}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${connection.token}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          throw new JiraError(
            "Jira rejected the token. Check its permissions in Settings.",
            502
          );
        }
        if (response.status === 404) {
          throw new JiraError(
            "Jira could not find this ticket or API endpoint.",
            404
          );
        }
        throw new JiraError(`Jira request failed (${response.status}).`, 502);
      }
      const chunks: Uint8Array[] = [];
      const reader = response.body?.getReader();
      let bytes = 0;
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          bytes += value.byteLength;
          if (bytes > 20 * 1024 * 1024) {
            await reader.cancel();
            throw new JiraError(
              "The Jira response exceeds the 20 MiB display limit.",
              502
            );
          }
          chunks.push(value);
        }
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
      } catch {
        throw new JiraError("Jira returned an invalid API response.", 502);
      }
    } catch (error) {
      if (error instanceof JiraError) {
        throw error;
      }
      // Upstream response bodies and fetch errors may contain credentials.
      throw new JiraError(
        "Could not reach Jira. Check the URL, connection, and TLS certificate.",
        502
      );
    }
  }

  private summary(connection: Connection, issue: Issue): JiraTicketSummary {
    const f = issue?.fields;
    if (
      !issue ||
      typeof issue.key !== "string" ||
      issue.key.length > 200 ||
      !JIRA_KEY.test(issue.key) ||
      !f ||
      typeof f.summary !== "string" ||
      typeof f.status?.name !== "string" ||
      typeof f.issuetype?.name !== "string" ||
      typeof f.updated !== "string" ||
      (f.priority !== null &&
        f.priority !== undefined &&
        typeof f.priority.name !== "string") ||
      (f.assignee !== null &&
        f.assignee !== undefined &&
        typeof f.assignee.displayName !== "string")
    ) {
      throw new JiraError("Jira returned an invalid ticket.", 502);
    }
    const statusId = f.status.id;
    const category = JIRA_STATUS_CATEGORIES.find(
      (c) => c === f.status.statusCategory?.key
    );
    return {
      key: issue.key,
      status: f.status.name,
      ...(typeof statusId === "string" && statusId.length <= 100
        ? { statusId }
        : {}),
      ...(category ? { statusCategory: category } : {}),
      title: f.summary,
      type: f.issuetype.name,
      updatedAt: f.updated,
      url: `${connection.url}/browse/${encodeURIComponent(issue.key)}`,
      ...(f.priority ? { priority: f.priority.name } : {}),
      ...(f.assignee ? { assignee: f.assignee.displayName } : {}),
    };
  }

  async tickets(input: Partial<JiraTicketQuery> = {}): Promise<JiraTickets> {
    const query = { ...JIRA_DEFAULT_QUERY, ...input };
    if (!validQuery(query)) {
      throw new JiraError("Invalid Jira search or page.");
    }
    const { startAt } = query;
    const jql = ticketJql(query);
    const connection = await this.connection();
    const params = new URLSearchParams({
      fields: FIELDS,
      jql,
      maxResults: String(PAGE_SIZE),
      startAt: String(startAt),
    });
    // A key lookup ignores the board, like it ignores every other filter.
    const route =
      query.scope === "board" && !jql.startsWith("key = ")
        ? `rest/agile/1.0/board/${query.board}/issue?${params}`
        : `rest/api/2/search?${params}`;
    const result = await this.json<{
      issues: Issue[];
      total: number;
      startAt: number;
      maxResults: number;
    }>(connection, route);
    if (
      !result ||
      !Array.isArray(result.issues) ||
      !Number.isSafeInteger(result.total) ||
      result.total < 0 ||
      result.startAt !== startAt ||
      !Number.isSafeInteger(result.maxResults) ||
      result.maxResults < 0 ||
      result.issues.length > PAGE_SIZE ||
      (result.issues.length === 0 && startAt < result.total)
    ) {
      throw new JiraError("Jira returned an invalid ticket list.", 502);
    }
    const next = startAt + result.issues.length;
    return {
      tickets: result.issues.map((issue) => this.summary(connection, issue)),
      total: result.total,
      ...(next < result.total ? { nextStartAt: next } : {}),
    };
  }

  async ticket(key: string): Promise<JiraTicket> {
    key = key.toUpperCase();
    if (!JIRA_KEY.test(key) || key.length > 200) {
      throw new JiraError("Invalid Jira ticket key.");
    }
    const connection = await this.connection();
    const issue = await this.json<Issue>(
      connection,
      `rest/api/2/issue/${encodeURIComponent(key)}?fields=${FIELDS},description,project,reporter,labels,created`
    );
    const summary = this.summary(connection, issue);
    const f = issue.fields;
    if (
      (f.description !== null &&
        f.description !== undefined &&
        typeof f.description !== "string") ||
      typeof f.project?.name !== "string" ||
      typeof f.created !== "string" ||
      !Array.isArray(f.labels) ||
      f.labels.some((l) => typeof l !== "string") ||
      (f.reporter !== null &&
        f.reporter !== undefined &&
        typeof f.reporter.displayName !== "string")
    ) {
      throw new JiraError("Jira returned invalid ticket details.", 502);
    }
    return {
      ...summary,
      createdAt: f.created,
      description: jiraToMarkdown(f.description ?? ""),
      instanceUrl: connection.url,
      labels: f.labels,
      project: f.project.name,
      ...(f.reporter ? { reporter: f.reporter.displayName } : {}),
    };
  }

  /** Boards, favourite filters and projects for the Tickets page's pickers. */
  async catalog(): Promise<JiraCatalog> {
    const connection = await this.connection();
    const [boards, filters, projects] = await Promise.all([
      this.boards(connection),
      this.json<unknown>(connection, "rest/api/2/filter/favourite"),
      this.json<unknown>(connection, "rest/api/2/project"),
    ]);
    if (!Array.isArray(filters) || !Array.isArray(projects)) {
      throw new JiraError(
        "Jira returned an invalid filter or project list.",
        502
      );
    }
    return {
      boards,
      filters: filters
        .flatMap((f): JiraFilter[] => {
          const id = Number(f?.id);
          return isId(id) && typeof f.name === "string"
            ? [{ id, name: f.name }]
            : [];
        })
        .slice(0, CATALOG_LIMIT),
      projects: projects
        .flatMap((p): JiraProject[] =>
          typeof p?.key === "string" &&
          p.key.length <= 100 &&
          JIRA_PROJECT_KEY.test(p.key) &&
          typeof p.name === "string"
            ? [{ key: p.key, name: p.name }]
            : []
        )
        .slice(0, CATALOG_LIMIT),
    };
  }

  /** A board's columns and the status ids mapped to each, for the kanban layout. */
  async columns(board: number): Promise<JiraBoardColumn[]> {
    if (!isId(board)) {
      throw new JiraError("Invalid Jira board.");
    }
    const connection = await this.connection();
    const result = await this.json<{
      columnConfig?: { columns?: unknown } | null;
    }>(connection, `rest/agile/1.0/board/${board}/configuration`);
    const columns = result?.columnConfig?.columns;
    if (!Array.isArray(columns) || columns.length > CATALOG_LIMIT) {
      throw new JiraError("Jira returned an invalid board configuration.", 502);
    }
    return columns.flatMap((c): JiraBoardColumn[] =>
      typeof c?.name === "string" && Array.isArray(c.statuses)
        ? [
            {
              name: c.name,
              statusIds: c.statuses.flatMap((st: { id?: unknown } | null) =>
                typeof st?.id === "string" ? [st.id] : []
              ),
            },
          ]
        : []
    );
  }

  /** Boards come from Jira Software's agile API; without it there are simply none. */
  private async boards(connection: Connection): Promise<JiraBoard[]> {
    const boards: JiraBoard[] = [];
    for (let page = 0; page < BOARD_PAGES; page += 1) {
      let result: {
        values?: unknown;
        isLast?: unknown;
      };
      try {
        result = await this.json(
          connection,
          `rest/agile/1.0/board?startAt=${boards.length}&maxResults=${PAGE_SIZE}`
        );
      } catch (error) {
        if (error instanceof JiraError && error.status === 404 && page === 0) {
          return [];
        }
        throw error;
      }
      if (!result || !Array.isArray(result.values)) {
        throw new JiraError("Jira returned an invalid board list.", 502);
      }
      for (const b of result.values as {
        id?: unknown;
        name?: unknown;
        type?: unknown;
        location?: { projectKey?: unknown } | null;
      }[]) {
        if (isId(b?.id) && typeof b.name === "string") {
          const project = b.location?.projectKey;
          boards.push({
            id: b.id,
            name: b.name,
            type: typeof b.type === "string" ? b.type : "",
            ...(typeof project === "string" ? { project } : {}),
          });
        }
      }
      if (result.isLast !== false || result.values.length === 0) {
        break;
      }
    }
    return boards;
  }
}
