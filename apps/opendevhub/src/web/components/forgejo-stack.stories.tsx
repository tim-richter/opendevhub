import preview from "../../../.storybook/preview";
import { forgejoDetails } from "../mocks/fixtures";
import { ForgejoStack } from "./forgejo-stack";

const meta = preview.meta({
  args: { details: forgejoDetails, search: "" },
  component: ForgejoStack,
  parameters: { layout: "padded" },
  title: "Components/ForgejoStack",
});

/** #42 with #43 built on it. */
export const BottomOfStack = meta.story();

/** In the middle: one ancestor, two branches of descendants. */
export const Branching = meta.story({
  args: {
    details: {
      ...forgejoDetails,
      base: "feat/auth",
      stack: {
        ancestors: [
          {
            base: "main",
            head: "feat/auth",
            number: 40,
            title: "Session auth",
          },
        ],
        descendants: [
          {
            base: "feat/rate-limit",
            children: [
              {
                base: "feat/rate-limit-metrics",
                children: [],
                head: "feat/rate-limit-dashboard",
                number: 44,
                title: "Grafana dashboard for rate limits",
              },
            ],
            head: "feat/rate-limit-metrics",
            number: 43,
            title: "Rate limit: expose metrics",
          },
          {
            base: "feat/rate-limit",
            children: [],
            head: "feat/rate-limit-docs",
            number: 45,
            title: "Document rate limits",
          },
        ],
      },
    },
  },
});
