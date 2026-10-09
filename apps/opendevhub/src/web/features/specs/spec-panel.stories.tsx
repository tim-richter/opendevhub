import { http, HttpResponse } from "msw";

import preview from "../../../../.storybook/preview";
import type { SessionSummary, SpecView } from "../../../shared/types";
import { specView } from "../../mocks/fixtures";
import { failing } from "../../mocks/handlers";
import { mockApi } from "../../mocks/story";
import { SpecSection } from "./spec-panel";

const variant = (n: number, model: string): SessionSummary => ({
  context: 0,
  cost: 0.31,
  directory: `/workspaces/.worktrees/acme-web/login-limit-${n}`,
  id: `ses_spec0${n}`,
  model: { id: model, providerID: "anthropic" },
  projectId: "acme-web",
  status: "idle",
  task: {
    of: 2,
    spec: { phase: "propose" },
    task: "tsk_spec",
    title: "Limit login attempts",
    variant: n,
  },
  title: "Limit login attempts",
  tokens: 52_000,
  updatedAt: Date.now(),
});

const spec = (view: SpecView) =>
  mockApi(
    {},
    http.get("/api/projects/:id/spec", () => HttpResponse.json(view))
  );

const meta = preview.meta({
  args: { projectId: "acme-web", sessions: [variant(1, "claude-opus-5-5")] },
  component: SpecSection,
  title: "Components/SpecSection",
});

/** A proposed change: its documents, the artifact chain and the requirements it adds, modifies and removes. */
export const Proposing = meta.story({});

/** Several variants proposed a change each: one tab per variant. */
export const Variants = meta.story({
  args: {
    sessions: [variant(1, "claude-opus-5-5"), variant(2, "claude-sonnet-5-5")],
  },
});

/** The agent made two changes in the worktree, so the view lets you pick. */
export const SeveralNewChanges = meta.story({
  beforeEach: spec({
    ...specView,
    changes: [
      ...specView.changes,
      {
        completedTasks: 0,
        isNew: true,
        name: "add-lockout-email",
        totalTasks: 2,
      },
    ],
  }),
});

/** `openspec validate` fails, and the tasks wait for the specs. */
export const Invalid = meta.story({
  beforeEach: spec({
    ...specView,
    change: specView.change && {
      ...specView.change,
      artifacts: [
        { id: "proposal", outputPath: "proposal.md", status: "done" },
        { id: "design", outputPath: "design.md", status: "ready" },
        { id: "specs", outputPath: "specs/**/*.md", status: "ready" },
        {
          id: "tasks",
          missingDeps: ["design", "specs"],
          outputPath: "tasks.md",
          status: "blocked",
        },
      ],
      planningComplete: false,
      requirements: [],
      validation: {
        issues: ["Change must have at least one delta. No deltas found."],
        valid: false,
      },
    },
  }),
});

/** The agent is still writing its proposal. */
export const NoChangeYet = meta.story({
  beforeEach: spec({ changes: specView.changes.filter((c) => !c.isNew) }),
});

/** The worktree's container is stopped. */
export const Unavailable = meta.story({
  beforeEach: spec({
    changes: [],
    unavailable:
      "this worktree's container is not running — start it from the Worktrees tab",
  }),
});

export const Failed = meta.story({
  beforeEach: mockApi(
    {},
    failing("get", "/api/projects/:id/spec", "opencode is not running")
  ),
});
