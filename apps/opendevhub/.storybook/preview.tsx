import addonA11y from "@storybook/addon-a11y";
import addonDocs from "@storybook/addon-docs";
import { definePreview } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import addonMsw from "msw-storybook-addon";
import { setupWorker } from "msw/browser";
import { useState } from "react";
import { MemoryRouter } from "react-router";

import { TooltipProvider } from "@/components/ui/tooltip";

import { DashboardProvider } from "../src/web/dashboard-context";
import { createHandlers } from "../src/web/mocks/handlers";

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

import "../src/web/styles.css";

declare module "@storybook/react-vite" {
  interface Parameters {
    /** The URL the story's router starts at, e.g. "/p/acme-web". */
    route?: string;
  }
}

export default definePreview({
  addons: [
    addonDocs(),
    addonA11y(),
    // The default handlers are the worker's initial ones: they survive the reset between stories,
    // and a story's own `msw.use(...)` takes precedence over them.
    addonMsw(async () => {
      const worker = setupWorker(...createHandlers());
      await worker.start({
        onUnhandledFrame: "bypass",
        quiet: true,
        serviceWorker: { url: "./mockServiceWorker.js" },
      });
      return worker;
    }),
  ],
  decorators: [
    (Story, { parameters }) => {
      // A client per story, so cached data never leaks from one story into the next.
      const [queryClient] = useState(
        () =>
          new QueryClient({
            defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
          })
      );
      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[parameters.route ?? "/"]}>
            <DashboardProvider>
              <TooltipProvider>
                <Story />
              </TooltipProvider>
            </DashboardProvider>
          </MemoryRouter>
        </QueryClientProvider>
      );
    },
  ],
  parameters: {
    a11y: { test: "todo" },
    layout: "fullscreen",
  },
});
