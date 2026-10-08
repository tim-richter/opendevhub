import preview from "../../../.storybook/preview";
import { webProject } from "../mocks/fixtures";
import { EnvBadge } from "./env-badge";

const [env] = webProject.environments;

const meta = preview.meta({
  args: { env },
  component: EnvBadge,
  parameters: { layout: "centered" },
  title: "Components/EnvBadge",
});

export const Running = meta.story();

export const Starting = meta.story({
  args: {
    env: { ...env, runtime: { ...env.runtime, containerState: "starting" } },
  },
});

export const OpencodeDown = meta.story({
  args: { env: { ...env, runtime: { ...env.runtime, opencode: "unhealthy" } } },
});

export const Failed = meta.story({
  args: {
    env: {
      ...env,
      runtime: {
        ...env.runtime,
        containerState: "error",
        error: "image build failed: exit code 1",
      },
    },
  },
});

/** On a node that can't be reached. */
export const Offline = meta.story({
  args: { env: { ...env, node: "laptop-old" } },
});
