import { http, HttpResponse } from "msw";
import { useEffect } from "react";

import preview from "../../../../.storybook/preview";
import { useDash } from "../../dashboard-context";
import type { NewTaskDraft } from "../../dashboard-context";
import { jiraTicket, models } from "../../mocks/fixtures";
import { failing } from "../../mocks/handlers";
import { mockApi } from "../../mocks/story";
import { NewTaskDialog } from "./new-task-dialog";

/** Opens the dialog the way the "New task" button does. */
const OpenNewTask = (props: { projectId?: string; draft?: NewTaskDraft }) => {
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

/** The environment has OpenSpec's opsx commands and CLI, so a task can start spec first. */
export const SpecFirst = meta.story({
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
