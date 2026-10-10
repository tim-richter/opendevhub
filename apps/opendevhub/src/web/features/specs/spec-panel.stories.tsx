import { http, HttpResponse } from "msw";

import preview from "../../../../.storybook/preview";
import type {
  ReviewData,
  SessionSummary,
  SpecView,
} from "../../../shared/types";
import { specView } from "../../mocks/fixtures";
import { failing } from "../../mocks/handlers";
import { mockApi } from "../../mocks/story";
import { SpecSection } from "./spec-panel";
import { specDraftKey } from "./specs";

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

/** Comments drafted on a proposal block, a requirement and in general, ready to send with `/opsx-update`. */
export const WithComments = meta.story({
  beforeEach: () => {
    const { directory } = variant(1, "claude-opus-5-5");
    localStorage.setItem(
      specDraftKey("acme-web", directory, "add-login-burst-limit"),
      JSON.stringify([
        {
          file: "proposal.md",
          id: "c1",
          line: 7,
          quote: [
            "- Limit login attempts to **5 per minute** per IP and account",
          ],
          text: "Per account only; shared office IPs would lock everyone out.",
        },
        {
          file: "specs/auth/spec.md",
          id: "c2",
          line: 8,
          quote: ["### Requirement: Login attempt limit"],
          start: 3,
          text: "Add a scenario for the account limit.",
        },
        { id: "c3", text: "Mention the lockout email as a non-goal." },
      ])
    );
    return () => localStorage.clear();
  },
});

/** The agent is working, so the comments wait for its turn to end. */
export const AgentWorking = meta.story({
  args: {
    sessions: [{ ...variant(1, "claude-opus-5-5"), status: "running" }],
  },
});

/** The agent wrote code while proposing, so approving asks first. */
export const CodeBeforeApproval = meta.story({
  args: {
    reviews: {
      [variant(1, "claude-opus-5-5").directory]: {
        files: [
          { file: "openspec/changes/add-login-burst-limit/proposal.md" },
          { file: "src/auth/rate-limiter.ts" },
          { file: "src/routes/login.ts" },
        ],
      } as ReviewData,
    },
  },
});

/** Once approved, the spec is read-only, and the bar follows the tasks the agent ticks off. */
export const Implementing = meta.story({
  args: {
    sessions: [
      {
        ...variant(1, "claude-opus-5-5"),
        task: {
          ...variant(1, "claude-opus-5-5").task,
          spec: { change: "add-login-burst-limit", phase: "implement" },
        } as SessionSummary["task"],
      },
    ],
  },
});

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
