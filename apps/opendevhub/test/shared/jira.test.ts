import { describe, expect, it } from "vitest";

import { jiraKanban } from "../../src/shared/jira";
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
