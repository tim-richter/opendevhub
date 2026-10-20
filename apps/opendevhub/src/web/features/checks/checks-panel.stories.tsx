import preview from "../../../../.storybook/preview";
import type { ChecksView } from "../../../shared/types";
import { checksView } from "../../mocks/fixtures";
import { checksState } from "./checks";
import { ChecksPanel } from "./checks-panel";

const panelProps = (view: ChecksView) => ({
  busy: false,
  checks: {
    cancel: () => Promise.resolve(),
    error: undefined,
    load: () => Promise.resolve(undefined as never),
    start: () => Promise.resolve(),
    state: checksState(view),
    view,
  },
  onClose: () => undefined,
  onFix: () => undefined,
});

const meta = preview.meta({
  component: ChecksPanel,
  decorators: [
    (Story) => (
      <div className="max-w-3xl p-4">
        <Story />
      </div>
    ),
  ],
  title: "Checks/Panel",
});

/** `static` groups typecheck and lint, with a Run group button on its heading; test stays on its own. */
export const Groups = meta.story({ args: panelProps(checksView) });

/** A group mid-run: its heading counts what passed so far, its button spins, and the running check can be cancelled. */
export const GroupRunning = meta.story({
  args: panelProps({
    ...checksView,
    run: {
      directory: "/w",
      dirty: false,
      head: "7c9d2f4",
      results: [
        {
          command: "pnpm typecheck",
          durationMs: 8400,
          exitCode: 0,
          name: "typecheck",
          output: [],
          status: "passed",
          where: "container",
        },
        {
          command: "pnpm exec ultracite check",
          name: "lint",
          output: [],
          status: "running",
          where: "host",
        },
      ],
      startedAt: 1,
    },
  }),
});
