import { http, HttpResponse } from "msw";
import { useEffect } from "react";
import { expect, userEvent, within } from "storybook/test";

import preview from "../../../../.storybook/preview";
import { useDash } from "../../dashboard-context";
import type { NewTaskDraft } from "../../dashboard-context";
import { basePositions, jiraTicket, models } from "../../mocks/fixtures";
import { failing, pending } from "../../mocks/handlers";
import { mockApi } from "../../mocks/story";
import { NewTaskDialog } from "./new-task-dialog";

/** Opens the dialog the way the "New task" button does. */
const OpenNewTask = (props: { projectId: string; draft?: NewTaskDraft }) => {
  const { newTask } = useDash();
  const { projectId, draft } = props;
  useEffect(() => newTask(projectId, draft), [newTask, projectId, draft]);
  return <NewTaskDialog />;
};

const meta = preview.meta({
  component: OpenNewTask,
  title: "Components/NewTaskDialog",
});

export const Default = meta.story({ args: { projectId: "acme-web" } });

export const ExistingWorktree = meta.story({
  args: {
    draft: {
      plan: {
        directory: "/workspaces/.worktrees/acme-web/rate-limit",
        environment: "shared",
        variants: [{}],
        where: "existing",
      },
    },
    projectId: "acme-web",
  },
});

/** Started from a Jira ticket: the prompt and title come prefilled. */
export const FromJira = meta.story({
  args: {
    draft: {
      jira: {
        description: jiraTicket("ACME-118").description,
        instanceUrl: "https://acme.atlassian.net",
        key: "ACME-118",
        title: "Login endpoint needs burst protection",
      },
      title: "ACME-118: Login endpoint needs burst protection",
    },
    projectId: "acme-web",
  },
});

/** Models can't be listed while opencode is down. */
export const ModelsUnavailable = meta.story({
  args: { projectId: "acme-web" },
  beforeEach: mockApi(
    {},
    failing("get", "/api/projects/:id/models", "opencode is not running")
  ),
});

/** The environment has OpenSpec's opsx commands and CLI, so a task can start spec first by exploring or proposing. */
export const SpecFirst = meta.story({
  args: { projectId: "acme-web" },
  beforeEach: mockApi(
    {},
    http.get("/api/projects/:id/models", () =>
      HttpResponse.json({
        ...models,
        spec: { cli: true, explore: true, missing: [] },
      })
    )
  ),
});

/** OpenSpec is set up without `opsx-explore`, so a spec-first task can only start by proposing. */
export const SpecWithoutExplore = meta.story({
  args: { projectId: "acme-web" },
  beforeEach: mockApi(
    {},
    http.get("/api/projects/:id/models", () =>
      HttpResponse.json({ ...models, spec: { cli: true, missing: [] } })
    )
  ),
});

/** The opsx commands are there but the container has no openspec CLI. */
export const SpecWithoutCli = meta.story({
  args: { projectId: "acme-web" },
  beforeEach: mockApi(
    {},
    http.get("/api/projects/:id/models", () =>
      HttpResponse.json({ ...models, spec: { cli: false, missing: [] } })
    )
  ),
});

/** Opens Options, where the Base field and its status line are. */
const openOptions = async () => {
  const body = within(document.body);
  await userEvent.click(await body.findByRole("button", { name: "Options" }));
  await body.findByRole("status");
};

/** `origin/main` is 5 commits ahead of a clean, checked-out `main`: starting updates it first. */
export const BaseStale = meta.story({
  args: { projectId: "acme-web" },
  beforeEach: mockApi({ basePosition: () => basePositions.stale }),
  play: async () => {
    await openOptions();
    await expect(
      await within(document.body).findByText(
        "Will update main from origin first · 5 new commits · fetched just now"
      )
    ).toBeVisible();
  },
});

export const BaseUpToDate = meta.story({
  args: { projectId: "acme-web" },
  beforeEach: mockApi({ basePosition: () => basePositions.upToDate }),
  play: openOptions,
});

/** The main checkout has uncommitted changes, so `main` stays where it is. */
export const BaseDirty = meta.story({
  args: { projectId: "acme-web" },
  beforeEach: mockApi({ basePosition: () => basePositions.dirty }),
  play: openOptions,
});

/** Local `main` has commits `origin/main` lacks, and the other way round. */
export const BaseDiverged = meta.story({
  args: { projectId: "acme-web" },
  beforeEach: mockApi({ basePosition: () => basePositions.diverged }),
  play: openOptions,
});

/** The remote can't be reached; the last good fetch was two hours ago. */
export const BaseOffline = meta.story({
  args: { projectId: "acme-web" },
  beforeEach: mockApi({ basePosition: () => basePositions.offline }),
  play: openOptions,
});

/** "Update the base branch before starting a task" is off. */
export const BaseSettingOff = meta.story({
  args: { projectId: "acme-web" },
  beforeEach: mockApi({ basePosition: () => basePositions.disabled }),
  play: openOptions,
});

/** The position is still being read (and fetched). */
export const BaseLoading = meta.story({
  args: { projectId: "acme-web" },
  beforeEach: mockApi({}, pending("get", "/api/projects/:id/base-position")),
  play: openOptions,
});
