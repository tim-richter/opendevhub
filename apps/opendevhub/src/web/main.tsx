import { TanStackDevtools } from "@tanstack/react-devtools";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtoolsPanel } from "@tanstack/react-query-devtools";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";

import { ConfirmDialogHost } from "@/components/confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";

import { App } from "./app";
import { DashboardProvider } from "./dashboard-context";

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";

import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
});

const rootElement = document.querySelector("#root");
if (!rootElement) {
  throw new Error("#root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <DashboardProvider>
          <TooltipProvider>
            <App />
            <ConfirmDialogHost />
          </TooltipProvider>
        </DashboardProvider>
      </BrowserRouter>
      <TanStackDevtools
        plugins={[
          { name: "TanStack Query", render: <ReactQueryDevtoolsPanel /> },
        ]}
      />
    </QueryClientProvider>
  </StrictMode>
);
