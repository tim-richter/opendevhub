import { TanStackDevtools } from "@tanstack/react-devtools";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { RouterContextProvider } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ConfirmDialogHost } from "@/components/confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";

import { App, createAppRouter } from "./app";
import { DashboardProvider } from "./dashboard-context";

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

const router = createAppRouter();

const rootElement = document.querySelector("#root");
if (!rootElement) {
  throw new Error("#root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
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
    </QueryClientProvider>
  </StrictMode>
);
