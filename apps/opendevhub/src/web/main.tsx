import { TooltipProvider } from "@opendevhub/ui/tooltip";
import { TanStackDevtools } from "@tanstack/react-devtools";
import { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { RouterContextProvider } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ConfirmDialogHost } from "@/components/confirm-dialog";

import { App, createAppRouter } from "./app";
import { DashboardProvider } from "./dashboard-context";
import { PERSIST_MAX_AGE_MS, persistOptions } from "./lib/query-persistence";
import { AccessGate } from "./shell/access-gate";

import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";

import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { gcTime: PERSIST_MAX_AGE_MS, retry: false, staleTime: 30_000 },
  },
});

const router = createAppRouter();

const rootElement = document.querySelector("#root");
if (!rootElement) {
  throw new Error("#root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <AccessGate>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={persistOptions}
      >
        <RouterContextProvider router={router}>
          <DashboardProvider>
            <TooltipProvider>
              <App />
              <ConfirmDialogHost />
            </TooltipProvider>
          </DashboardProvider>
        </RouterContextProvider>
        <TanStackDevtools
          plugins={[
            { name: "TanStack Query", render: <ReactQueryDevtoolsPanel /> },
            {
              name: "TanStack Router",
              render: <TanStackRouterDevtoolsPanel router={router} />,
            },
          ]}
        />
      </PersistQueryClientProvider>
    </AccessGate>
  </StrictMode>
);
