import { defineMain } from "@storybook/react-vite/node";
import { msw } from "msw/vite";

export default defineMain({
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  core: { disableTelemetry: true },
  framework: "@storybook/react-vite",
  stories: ["../src/web/**/*.mdx", "../src/web/**/*.stories.tsx"],
  // Serves mockServiceWorker.js in dev and emits it next to iframe.html in builds, so no copy is checked in.
  viteFinal: (config) => ({
    ...config,
    plugins: [...(config.plugins ?? []), msw({ mode: "worker-only" })],
  }),
});
