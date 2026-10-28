import { describe, expect, it } from "vitest";

import {
  jiraKanban,
  jiraQueryParams,
  jiraTaskPrompt,
  parseJiraQuery,
} from "../../src/shared/jira";
import type { JiraTicketSummary } from "../../src/shared/jira";

const ticket = (
  key: string,
  status: string,
  extra: Partial<JiraTicketSummary> = {}
): JiraTicketSummary => ({
  key,
  status,
  title: key,
  type: "Story",
  updatedAt: "2026-10-01T00:00:00Z",
  url: `https://jira.example.com/browse/${key}`,
  ...extra,
});

const names = (columns: ReturnType<typeof jiraKanban>) =>
  columns.map((c) => [c.name, c.tickets.map((t) => t.key)]);

describe("jiraKanban", () => {
  it("makes a column per status, ordered by category and then first appearance", () => {
    expect(
      names(
        jiraKanban([
          ticket("A-1", "Done", { statusCategory: "done" }),
          ticket("A-2", "Review"),
          ticket("A-3", "To Do", { statusCategory: "new" }),
          ticket("A-4", "Done", { statusCategory: "done" }),
          ticket("A-5", "In Progress", { statusCategory: "indeterminate" }),
        ])
      )
    ).toStrictEqual([
      ["To Do", ["A-3"]],
      ["Review", ["A-2"]],
      ["In Progress", ["A-5"]],
      ["Done", ["A-1", "A-4"]],
    ]);
    expect(jiraKanban([])).toStrictEqual([]);
  });

  it("follows a board's columns, keeping empty ones and collecting unmapped statuses", () => {
    const board = [
      { name: "Backlog", statusIds: [] },
      { name: "Doing", statusIds: ["3", "4"] },
      { name: "Done", statusIds: ["5"] },
    ];
    expect(
      names(
        jiraKanban(
          [
            ticket("A-1", "Review", { statusId: "4" }),
            ticket("A-2", "Blocked", { statusId: "9" }),
            ticket("A-3", "Closed", { statusId: "5" }),
            ticket("A-4", "In Progress", { statusId: "3" }),
            ticket("A-5", "Unknown"),
          ],
          board
        )
      )
    ).toStrictEqual([
      ["Backlog", []],
      ["Doing", ["A-1", "A-4"]],
      ["Done", ["A-3"]],
      ["Other", ["A-2", "A-5"]],
    ]);
    expect(
      names(jiraKanban([ticket("A-1", "Done", { statusId: "5" })], board))
    ).toStrictEqual([
      ["Backlog", []],
      ["Doing", []],
      ["Done", ["A-1"]],
    ]);
  });
});

describe(parseJiraQuery, () => {
  it("reads raw JQL from the URL on one line and writes it back", () => {
    const query = parseJiraQuery(
      new URLSearchParams({ jql: "  labels = api\n  AND priority = High " })
    );
    expect(query?.jql).toBe("labels = api AND priority = High");
    expect(jiraQueryParams({ jql: "labels = api" }).get("jql")).toBe(
      "labels = api"
    );
    expect(
      parseJiraQuery(new URLSearchParams({ jql: "" }))?.jql
    ).toBeUndefined();
  });

  it("refuses JQL over the length limit", () => {
    expect(
      parseJiraQuery(new URLSearchParams({ jql: "x".repeat(2001) }))
    ).toBeUndefined();
  });
});

describe("jiraTaskPrompt", () => {
  const source = {
    description: "Users want a dark theme",
    instanceUrl: "https://jira.example.com",
    key: "APP-42",
    title: "Dark mode",
  };

  it("leads with the ticket and leaves comments out when none are picked", () => {
    expect(jiraTaskPrompt(source)).toBe(
      "Implement APP-42: Dark mode\n\nTicket: https://jira.example.com/browse/APP-42\n\nUsers want a dark theme"
    );
  });

  it("follows the description with the picked comments, oldest first", () => {
    const prompt = jiraTaskPrompt({
      ...source,
      comments: [
        {
          author: "Alex Kim",
          body: "Respect the OS setting.",
          createdAt: "2026-10-01T09:00:00.000Z",
          id: "1",
        },
        {
          author: "Sam Lee",
          body: "Keep the toggle in settings.",
          createdAt: "2026-10-03T12:00:00.000Z",
          id: "2",
        },
      ],
    });
    expect(prompt).toBe(
      "Implement APP-42: Dark mode\n\nTicket: https://jira.example.com/browse/APP-42\n\nUsers want a dark theme\n\nRelevant comments from the ticket:\n\n**Alex Kim** on 2026-10-01:\n\nRespect the OS setting.\n\n**Sam Lee** on 2026-10-03:\n\nKeep the toggle in settings."
    );
  });
});
