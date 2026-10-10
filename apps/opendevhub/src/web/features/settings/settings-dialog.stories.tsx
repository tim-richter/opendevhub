import preview from "../../../../.storybook/preview";
import { App } from "../../app";
import { gitSetupBare, integrationOff } from "../../mocks/fixtures";
import { mockApi } from "../../mocks/story";

const meta = preview.meta({
  component: App,
  parameters: { route: "/?settings=general" },
  title: "Shell/Settings",
});

/** Project folders. */
export const General = meta.story();

export const Notifications = meta.story({
  parameters: { route: "/?settings=notifications" },
});

export const Shortcuts = meta.story({
  parameters: { route: "/?settings=shortcuts" },
});

/** Rename projects and open their checks. */
export const Projects = meta.story({
  parameters: { route: "/?settings=projects" },
});

/** Formerly the Nodes page. */
export const RemoteInstances = meta.story({
  parameters: { route: "/?settings=remote-instances" },
});

/** Identity, agent keys, and a host whose key isn't loaded. */
export const Git = meta.story({ parameters: { route: "/?settings=git" } });

/** No identity, no agent, no keys. */
export const GitUnconfigured = meta.story({
  beforeEach: mockApi({ git: gitSetupBare }),
  parameters: { route: "/?settings=git" },
});

/** Jira and Forgejo connected, so both get their own page in the nav. */
export const Integrations = meta.story({
  parameters: { route: "/?settings=integrations" },
});

/** Neither set up: the nav lists only Integrations. */
export const IntegrationsOff = meta.story({
  beforeEach: mockApi({ forgejo: integrationOff, jira: integrationOff }),
  parameters: { route: "/?settings=integrations" },
});

export const Forgejo = meta.story({
  parameters: { route: "/?settings=forgejo" },
});
