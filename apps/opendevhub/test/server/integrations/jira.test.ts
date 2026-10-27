import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileForgejoSettings } from "../../../src/server/integrations/forgejo";
import {
  FileJiraSettings,
  Jira,
  jiraUrl,
  splitJql,
  ticketJql,
} from "../../../src/server/integrations/jira";
import { CredentialStoreError } from "../../../src/server/integrations/secrets";
import { JIRA_DEFAULT_QUERY } from "../../../src/shared/jira";
import { MemorySecretStore } from "../../helpers/secrets";

let dir: string;
let secrets: MemorySecretStore;
let settings: FileJiraSettings;
const configured = {
  enabled: true,
  url: "https://jira.example.com/jira",
  token: "jira-secret",
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const issue = (key = "APP-1", fields: Record<string, unknown> = {}) => ({
  key,
  self: "https://attacker.example.com",
  fields: {
    summary: "Fix login",
    description: "Fails on Safari\nAcceptance: login succeeds",
    status: { name: "In Progress" },
    issuetype: { name: "Bug" },
    priority: { name: "High" },
    assignee: { displayName: "Alice" },
    project: { name: "App" },
    reporter: { displayName: "Bob" },
    labels: ["login"],
    created: "2026-10-01T12:00:00Z",
    updated: "2026-10-07T12:00:00Z",
    ...fields,
  },
});
/** Answers Jira's field list itself, so `fetcher` sees only the requests a test is about. */
const withFields =
  (fetcher: typeof fetch, fields: unknown[] = []): typeof fetch =>
  (input, init) =>
    new URL(String(input)).pathname.endsWith("/rest/api/2/field")
      ? Promise.resolve(response(fields))
      : fetcher(input, init);
const page = (issues = [issue()], total = issues.length, startAt = 0) => ({
  issues,
  total,
  startAt,
  maxResults: 50,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-jira-"));
  secrets = new MemorySecretStore();
  settings = new FileJiraSettings(dir, secrets);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("protected Jira settings", () => {
  it("is opt-in, persists only a credential reference, and keeps Forgejo independent", async () => {
    await expect(settings.view()).resolves.toStrictEqual({
      enabled: false,
      url: "",
      hasToken: false,
    });
    await settings.save(configured);
    const forgejo = new FileForgejoSettings(dir, secrets);
    await forgejo.save({
      enabled: true,
      url: "https://forge.example.com",
      token: "forge-secret",
    });
    await expect(
      new FileJiraSettings(dir, secrets).read()
    ).resolves.toStrictEqual(configured);
    const file = path.join(dir, "integrations/jira.json");
    expect(fs.readFileSync(file, "utf-8")).not.toContain(configured.token);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(await settings.view())).not.toContain(
      configured.token
    );
    await settings.save({ enabled: false, url: configured.url });
    expect((await settings.read()).token).toBe(configured.token);
    await settings.save({ ...configured, token: "replacement" });
    expect([...secrets.values.values()].sort()).toStrictEqual([
      "forge-secret",
      "replacement",
    ]);
    await settings.save({
      enabled: false,
      url: configured.url,
      clearToken: true,
    });
    await expect(settings.view()).resolves.toStrictEqual({
      enabled: false,
      url: configured.url,
      hasToken: false,
    });
    expect((await forgejo.read()).token).toBe("forge-secret");
  });

  it("never reuses a credential on a different URL and never falls back to plaintext", async () => {
    await settings.save(configured);
    await expect(
      settings.save({ enabled: true, url: "https://other.example.com" })
    ).rejects.toThrow("URL and token");
    expect((await settings.read()).url).toBe(configured.url);
    vi.spyOn(secrets, "set").mockRejectedValue(new CredentialStoreError());
    await expect(
      settings.save({ ...configured, token: "replacement" })
    ).rejects.toThrow("OS credential store");
    expect((await settings.read()).token).toBe(configured.token);
    expect(
      fs.readFileSync(path.join(dir, "integrations/jira.json"), "utf-8")
    ).not.toContain("replacement");
  });

  it("enforces HTTPS and rejects embedded credentials or query strings", () => {
    for (const url of [
      "http://jira.example.com",
      "https://alice:secret@example.com",
      "https://example.com?token=secret",
      "https://example.com#secret",
      "file:///tmp/jira",
      "https://example.com/%2fother",
    ]) {
      expect(() => jiraUrl(url)).toThrow();
    }
    expect(jiraUrl(" http://127.0.0.1:8080/jira/ ")).toBe(
      "http://127.0.0.1:8080/jira"
    );
  });

  it("does not access the credential store or network when disabled, and reports missing credentials", async () => {
    const fetcher = vi.fn();
    const jira = new Jira(settings, withFields(fetcher));
    await expect(jira.tickets()).rejects.toMatchObject({ status: 412 });
    await settings.save(configured);
    await settings.save({ enabled: false, url: configured.url });
    const get = vi.spyOn(secrets, "get");
    await expect(jira.ticket("APP-1")).rejects.toMatchObject({ status: 412 });
    expect(get).not.toHaveBeenCalled();
    await settings.save({ enabled: true, url: configured.url });
    secrets.values.clear();
    await expect(jira.tickets()).rejects.toThrow(
      "missing from the OS credential store"
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Jira Server/Data Center API", () => {
  it("defaults to assigned tickets and pages using the server's returned count", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(page([issue()], 2)))
      .mockResolvedValueOnce(response(page([issue("APP-2")], 2, 1)));
    const jira = new Jira(settings, withFields(fetcher));
    const first = await jira.tickets();
    expect(first).toMatchObject({
      total: 2,
      nextStartAt: 1,
      tickets: [
        {
          key: "APP-1",
          title: "Fix login",
          url: `${configured.url}/browse/APP-1`,
        },
      ],
    });
    await expect(
      jira.tickets({ startAt: first.nextStartAt })
    ).resolves.not.toHaveProperty("nextStartAt");
    for (const [url, init] of fetcher.mock.calls) {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/jira/rest/api/2/search");
      expect(parsed.searchParams.get("jql")).toBe(
        "assignee = currentUser() ORDER BY updated DESC"
      );
      expect(parsed.searchParams.get("maxResults")).toBe("50");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer jira-secret",
      });
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(
      new URL(String(fetcher.mock.calls[1][0])).searchParams.get("startAt")
    ).toBe("1");
    expect(JSON.stringify(first)).not.toContain("jira-secret");
  });

  it("searches exact keys across assignees and safely quotes text as a Lucene phrase", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response(page([])));
    const jira = new Jira(settings, withFields(fetcher));
    await jira.tickets({ search: " app-123 ", scope: "board", board: 7 });
    expect(
      new URL(String(fetcher.mock.calls[0][0])).searchParams.get("jql")
    ).toBe('key = "APP-123"');
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe(
      "/jira/rest/api/2/search"
    );
    const text = 'login" OR assignee = admin';
    await jira.tickets({ search: text, scope: "all" });
    const jql = new URL(String(fetcher.mock.calls[1][0])).searchParams.get(
      "jql"
    )!;
    expect(jql).toBe(
      `text ~ ${JSON.stringify('"login\\" OR assignee = admin"')} ORDER BY updated DESC`
    );
    expect(jql).not.toContain("currentUser()");
  });

  it("combines views and filters into JQL and lists boards through the agile API", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response(page([])));
    const jira = new Jira(settings, withFields(fetcher));
    const call = (index: number) =>
      new URL(String(fetcher.mock.calls[index][0]));
    await jira.tickets({
      scope: "watching",
      project: "APP",
      status: "open",
      sort: "priority",
    });
    expect(call(0).searchParams.get("jql")).toBe(
      'watcher = currentUser() AND project = "APP" AND statusCategory != done ORDER BY priority DESC, updated DESC'
    );
    await jira.tickets({ scope: "filter", filter: 10_100, status: "todo" });
    expect(call(1).searchParams.get("jql")).toBe(
      "filter = 10100 AND statusCategory = new ORDER BY updated DESC"
    );
    await jira.tickets({
      scope: "board",
      board: 7,
      sprint: true,
      sort: "rank",
    });
    expect(call(2).pathname).toBe("/jira/rest/agile/1.0/board/7/issue");
    expect(call(2).searchParams.get("jql")).toBe(
      "sprint in openSprints() ORDER BY Rank ASC"
    );
    expect(call(1).pathname).toBe("/jira/rest/api/2/search");
  });

  it("adds raw JQL in parentheses and lets its ORDER BY replace the sort", () => {
    expect(
      ticketJql({
        ...JIRA_DEFAULT_QUERY,
        jql: "labels = backend OR component = API",
        status: "open",
      })
    ).toBe(
      "assignee = currentUser() AND (labels = backend OR component = API) AND statusCategory != done ORDER BY updated DESC"
    );
    expect(
      ticketJql({
        ...JIRA_DEFAULT_QUERY,
        jql: "fixVersion = 2.0 order by duedate ASC",
        scope: "all",
      })
    ).toBe("(fixVersion = 2.0) ORDER BY duedate ASC");
    expect(splitJql("ORDER BY created")).toStrictEqual({
      order: "created",
      where: "",
    });
  });

  it("refuses JQL with control characters or over the length limit", async () => {
    await settings.save(configured);
    const fetcher = vi.fn<typeof fetch>();
    const jira = new Jira(settings, withFields(fetcher));
    await expect(jira.tickets({ jql: "a\u0000b" })).rejects.toThrow(
      "Invalid Jira search"
    );
    await expect(jira.tickets({ jql: "x".repeat(2001) })).rejects.toThrow(
      "Invalid Jira search"
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads boards across pages, favourite filters and projects, skipping malformed entries", async () => {
    await settings.save(configured);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const { pathname, searchParams } = new URL(String(url));
      if (pathname.endsWith("/board")) {
        return searchParams.get("startAt") === "0"
          ? response({
              isLast: false,
              values: [
                {
                  id: 1,
                  name: "Sprint board",
                  type: "scrum",
                  location: { projectKey: "APP" },
                },
                { id: "x", name: "bad" },
              ],
            })
          : response({
              isLast: true,
              values: [{ id: 2, name: "Kanban", type: "kanban" }],
            });
      }
      if (pathname.endsWith("/filter/favourite")) {
        return response([
          { id: "10100", name: "Bugs", jql: "type = Bug" },
          { id: "-1", name: "bad" },
        ]);
      }
      return response([
        { key: "APP", name: "App", id: "1" },
        { key: "bad key", name: "x" },
      ]);
    });
    await expect(
      new Jira(settings, withFields(fetcher)).catalog()
    ).resolves.toStrictEqual({
      boards: [
        { id: 1, name: "Sprint board", type: "scrum", project: "APP" },
        { id: 2, name: "Kanban", type: "kanban" },
      ],
      filters: [{ id: 10_100, name: "Bugs" }],
      projects: [{ key: "APP", name: "App" }],
    });
    const withoutAgile = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) =>
        String(url).includes("/agile/")
          ? new Response("", { status: 404 })
          : response([])
      );
    await expect(
      new Jira(settings, withoutAgile).catalog()
    ).resolves.toStrictEqual({
      boards: [],
      filters: [],
      projects: [],
    });
  });

  it("reports status ids and categories and reads a board's columns", async () => {
    await settings.save(configured);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) =>
      String(url).endsWith("/configuration")
        ? response({
            columnConfig: {
              columns: [
                { name: "To Do", statuses: [{ id: "1" }, { id: 2 }] },
                { name: "Done", statuses: [] },
                { statuses: [{ id: "5" }] },
              ],
            },
          })
        : response(
            page([
              issue("APP-1", {
                status: {
                  id: "3",
                  name: "In Progress",
                  statusCategory: { key: "indeterminate" },
                },
              }),
              issue("APP-2", {
                status: { name: "Odd", statusCategory: { key: "weird" } },
              }),
            ])
          )
    );
    const jira = new Jira(settings, withFields(fetcher));
    const { tickets } = await jira.tickets();
    expect(tickets[0]).toMatchObject({
      statusCategory: "indeterminate",
      statusId: "3",
    });
    expect(tickets[1]).not.toHaveProperty("statusId");
    expect(tickets[1]).not.toHaveProperty("statusCategory");
    await expect(jira.columns(7)).resolves.toStrictEqual([
      { name: "To Do", statusIds: ["1"] },
      { name: "Done", statusIds: [] },
    ]);
    expect(new URL(String(fetcher.mock.calls[1][0])).pathname).toBe(
      "/jira/rest/agile/1.0/board/7/configuration"
    );
    await expect(jira.columns(0)).rejects.toThrow("Invalid Jira board.");
    fetcher.mockImplementation(async () => response({ columnConfig: null }));
    await expect(jira.columns(7)).rejects.toThrow(
      "invalid board configuration"
    );
  });

  it("loads ticket details and builds links from the configured instance", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(issue()))
      .mockResolvedValueOnce(
        response(
          issue("APP-1", {
            description: null,
            assignee: null,
            priority: null,
            reporter: null,
          })
        )
      );
    const jira = new Jira(settings, withFields(fetcher));
    await expect(jira.ticket("app-1")).resolves.toMatchObject({
      key: "APP-1",
      project: "App",
      instanceUrl: configured.url,
      description: "Fails on Safari\\\nAcceptance: login succeeds",
      labels: ["login"],
      assignee: "Alice",
      reporter: "Bob",
      priority: "High",
      url: `${configured.url}/browse/APP-1`,
    });
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "/rest/api/2/issue/APP-1?fields="
    );
    await expect(jira.ticket("APP-1")).resolves.toMatchObject({
      commentTotal: 0,
      comments: [],
      description: "",
    });
  });

  it("loads a ticket's comments as Markdown, leaving out malformed ones", async () => {
    await settings.save(configured);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      response(
        issue("APP-1", {
          comment: {
            comments: [
              {
                author: { displayName: "Carol" },
                body: "Looks *good*",
                created: "2026-10-02T12:00:00.000Z",
                id: "1",
                updated: "2026-10-02T12:00:00.004Z",
              },
              { body: "No id", created: "2026-10-02T12:00:00Z" },
              {
                author: null,
                body: "Edited later",
                created: "2026-10-03T12:00:00Z",
                id: "2",
                updated: "2026-10-04T12:00:00Z",
              },
            ],
            total: 7,
          },
        })
      )
    );
    const jira = new Jira(settings, withFields(fetcher));
    const ticket = await jira.ticket("APP-1");
    expect(String(fetcher.mock.calls[0][0])).toContain(",comment");
    expect(ticket.commentTotal).toBe(7);
    expect(ticket.comments).toEqual([
      {
        author: "Carol",
        body: "Looks **good**",
        createdAt: "2026-10-02T12:00:00.000Z",
        id: "1",
      },
      {
        author: "Unknown user",
        body: "Edited later",
        createdAt: "2026-10-03T12:00:00Z",
        id: "2",
        updatedAt: "2026-10-04T12:00:00Z",
      },
    ]);
  });

  it("shows each ticket's epic by name and colour from Jira Software's epic fields", async () => {
    await settings.save(configured);
    const fields = [
      { id: "summary", schema: { system: "summary" } },
      {
        id: "customfield_10100",
        schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-link" },
      },
      {
        id: "customfield_10102",
        schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-label" },
      },
      {
        id: "customfield_10104",
        schema: { custom: "com.pyxis.greenhopper.jira:gh-epic-color" },
      },
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response(
          page([
            issue("APP-1", { customfield_10100: "APP-9" }),
            issue("APP-2", { customfield_10100: "APP-9" }),
            issue("APP-3", { customfield_10100: "OPS-4" }),
            issue("APP-4", { customfield_10100: "not a key" }),
            issue("APP-5"),
          ])
        )
      )
      .mockResolvedValueOnce(
        response({
          issues: [
            {
              key: "APP-9",
              fields: {
                summary: "Login overhaul",
                customfield_10102: "Milestone 5",
                customfield_10104: "ghx-label-9",
              },
            },
          ],
        })
      )
      .mockResolvedValueOnce(
        response(issue("APP-1", { customfield_10100: "OPS-4" }))
      )
      .mockResolvedValueOnce(
        response({
          issues: [
            {
              key: "OPS-4",
              fields: { summary: "Infra", customfield_10104: "ghx-label-99" },
            },
          ],
        })
      );
    const lookups = vi.fn(withFields(fetcher, fields));
    const jira = new Jira(settings, lookups);
    const { tickets } = await jira.tickets();
    expect(tickets.map((t) => t.epic)).toStrictEqual([
      { key: "APP-9", name: "Milestone 5", color: 9 },
      { key: "APP-9", name: "Milestone 5", color: 9 },
      // Jira did not return this epic, so it keeps its key.
      { key: "OPS-4", name: "OPS-4" },
      undefined,
      undefined,
    ]);
    const [list, epics] = fetcher.mock.calls.map(
      ([url]) => new URL(String(url))
    );
    expect(list.searchParams.get("fields")).toContain(",customfield_10100");
    expect(epics.pathname).toBe("/jira/rest/api/2/search");
    expect(Object.fromEntries(epics.searchParams)).toMatchObject({
      fields: "summary,customfield_10102,customfield_10104",
      jql: "key in (APP-9, OPS-4)",
      validateQuery: "false",
    });
    await expect(jira.ticket("APP-1")).resolves.toMatchObject({
      epic: { key: "OPS-4", name: "Infra" },
    });
    expect(String(fetcher.mock.calls[2][0])).toContain(",customfield_10100");
    // The field ids are looked up once per instance.
    expect(lookups).toHaveBeenCalledTimes(5);
  });

  it("lists tickets without epics when Jira has no epic fields or will not list them", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() =>
        Promise.resolve(response(page([issue("APP-1")])))
      );
    for (const lookup of [
      withFields(fetcher),
      (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).endsWith("/rest/api/2/field")
          ? Promise.resolve(new Response("", { status: 403 }))
          : fetcher(input, init),
    ]) {
      const { tickets } = await new Jira(settings, lookup).tickets();
      expect(tickets[0]).not.toHaveProperty("epic");
    }
    expect(
      new URL(String(fetcher.mock.calls[0][0])).searchParams.get("fields")
    ).toBe("summary,status,issuetype,priority,assignee,updated");
  });

  it("rejects invalid keys, searches and offsets before sending any credentials", async () => {
    await settings.save(configured);
    const fetcher = vi.fn();
    const jira = new Jira(settings, withFields(fetcher));
    for (const key of ["..", "APP-1?x=y", "APP/1", "APP-0"]) {
      await expect(jira.ticket(key)).rejects.toMatchObject({ status: 400 });
    }
    for (const offset of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(jira.tickets({ startAt: offset })).rejects.toMatchObject({
        status: 400,
      });
    }
    for (const query of [
      { search: "x".repeat(501) },
      { search: "x\ny" },
      { scope: "board" as const },
      { scope: "filter" as const, filter: 0 },
      { board: 1 },
      { project: 'APP" OR project = X' },
      { status: "closed" as never },
      { sort: "key" as never },
    ]) {
      await expect(jira.tickets(query)).rejects.toMatchObject({ status: 400 });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sanitizes authentication, upstream, network and redirect errors", async () => {
    await settings.save(configured);
    for (const status of [401, 403, 404, 429, 500]) {
      const jira = new Jira(
        settings,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response("jira-secret upstream details", { status })
          )
      );
      const err = await jira.tickets().catch((error: Error) => error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain("jira-secret");
      expect((err as Error).message).not.toContain("upstream details");
      expect(err).toMatchObject({ status: status === 404 ? 404 : 502 });
    }
    await expect(
      new Jira(
        settings,
        vi.fn().mockRejectedValue(new Error("jira-secret redirect"))
      ).tickets()
    ).rejects.toThrow("Could not reach Jira");
  });

  it("bounds responses and rejects malformed lists and details", async () => {
    await settings.save(configured);
    for (const value of [
      null,
      {},
      page([issue()], -1),
      page([], 1),
      page([issue()], 1, 5),
      page([issue("../APP-1")]),
    ]) {
      await expect(
        new Jira(
          settings,
          withFields(vi.fn<typeof fetch>().mockResolvedValue(response(value)))
        ).tickets()
      ).rejects.toMatchObject({ status: 502 });
    }
    await expect(
      new Jira(
        settings,
        withFields(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response("<html>secret</html>"))
        )
      ).tickets()
    ).rejects.toThrow("invalid API response");
    await expect(
      new Jira(
        settings,
        withFields(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              response(issue("APP-1", { description: { content: [] } }))
            )
        )
      ).ticket("APP-1")
    ).rejects.toThrow("invalid ticket details");
    await expect(
      new Jira(
        settings,
        withFields(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(
              new Response(new Uint8Array(20 * 1024 * 1024 + 1))
            )
        )
      ).tickets()
    ).rejects.toThrow("20 MiB");
  });
});
