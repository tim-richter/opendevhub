import { JIRA_KEY } from "../shared/jira";
import type {
  JiraSettings,
  JiraTicket,
  JiraTicketSummary,
  JiraTickets,
} from "../shared/jira";
import {
  FileIntegrationSettings,
  IntegrationError,
  integrationUrl,
} from "./integration-settings";
import { jiraToMarkdown } from "./jira-markup";
import { OsSecretStore } from "./secrets";
import type { SecretStore } from "./secrets";

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
    status: { name: string };
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

/** Jira Server/Data Center REST v2 with a personal access token (Bearer authentication). */
export class Jira {
  constructor(
    private readonly settings: FileJiraSettings,
    private readonly fetcher: typeof fetch = fetch
  ) {}

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

  private async json<T>(connection: Connection, route: string): Promise<T> {
    try {
      const response = await this.fetcher(
        `${connection.url}/rest/api/2/${route}`,
        {
          headers: {
            accept: "application/json",
            authorization: `Bearer ${connection.token}`,
          },
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        }
      );
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
    return {
      key: issue.key,
      status: f.status.name,
      title: f.summary,
      type: f.issuetype.name,
      updatedAt: f.updated,
      url: `${connection.url}/browse/${encodeURIComponent(issue.key)}`,
      ...(f.priority ? { priority: f.priority.name } : {}),
      ...(f.assignee ? { assignee: f.assignee.displayName } : {}),
    };
  }

  async tickets(search = "", startAt = 0): Promise<JiraTickets> {
    if (
      search.length > 500 ||
      /[\u0000-\u001F]/u.test(search) ||
      !Number.isSafeInteger(startAt) ||
      startAt < 0
    ) {
      throw new JiraError("Invalid Jira search or page.");
    }
    const term = search.trim();
    // Escape both Lucene and JQL syntax: the search box accepts text, never arbitrary JQL.
    const phrase = `"${term.replaceAll(/[+\-&|!(){}[\]^"~*?:\\/]/gu, "\\$&")}"`;
    let jql;
    if (term) {
      if (JIRA_KEY.test(term.toUpperCase())) {
        jql = `key = ${JSON.stringify(term.toUpperCase())}`;
      } else {
        jql = `text ~ ${JSON.stringify(phrase)} ORDER BY updated DESC`;
      }
    } else {
      jql = "assignee = currentUser() ORDER BY updated DESC";
    }
    const connection = await this.connection();
    const query = new URLSearchParams({
      fields: FIELDS,
      jql,
      maxResults: String(PAGE_SIZE),
      startAt: String(startAt),
    });
    const result = await this.json<{
      issues: Issue[];
      total: number;
      startAt: number;
      maxResults: number;
    }>(connection, `search?${query}`);
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
      `issue/${encodeURIComponent(key)}?fields=${FIELDS},description,project,reporter,labels,created`
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
}
