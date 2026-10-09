import {
  createRootRoute,
  createRoute,
  createRouter,
  Matches,
  redirect,
} from "@tanstack/react-router";
import type { AnyRoute, RouterHistory } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import type { ReactNode } from "react";

import { legacyPath } from "./checkouts";
import { Shell } from "./layout/shell";
import {
  CheckoutPage,
  CheckoutRuntime,
  CheckoutSessions,
} from "./pages/checkout-page";
import { CleanupPage } from "./pages/cleanup-page";
import { ForgejoPage, ForgejoPullPage } from "./pages/forgejo-page";
import { JiraPage, JiraTicketPage } from "./pages/jira-page";
import { NodesPage } from "./pages/nodes-page";
import { NotFound } from "./pages/not-found";
import { Overview } from "./pages/overview";
import { ProjectLayout } from "./pages/project-layout";
import { ProjectOverview } from "./pages/project-overview";
import { ProjectReview } from "./pages/project-review";
import { ProjectTask } from "./pages/project-task";
import { SessionPage } from "./pages/session-page";
import { SessionsPage } from "./pages/sessions-page";
import { SettingsPage } from "./pages/settings-page";
import { UsagePage } from "./pages/usage-page";
import { parseSearch, stringifySearch } from "./routing";

const CheckoutTerminal = lazy(() =>
  import("./pages/checkout-terminal").then((module) => ({
    default: module.CheckoutTerminal,
  }))
);

const OLD_RUNTIME_TAB = /\/(?:ports|logs)$/u;

const rootRoute = createRootRoute();

const shellRoute = createRoute({
  component: Shell,
  getParentRoute: () => rootRoute,
  id: "shell",
});

const page = (path: string, component: () => ReactNode) =>
  createRoute({ component, getParentRoute: () => shellRoute, path });

const projectRoute = createRoute({
  component: ProjectLayout,
  getParentRoute: () => shellRoute,
  path: "p/$projectId",
});

/** The tabs of one checkout; the main checkout and each worktree get their own copy. */
const checkoutTabs = (parent: AnyRoute) => {
  const tab = (path: string, component: () => ReactNode) =>
    createRoute({ component, getParentRoute: () => parent, path });
  return [
    tab("/", CheckoutSessions),
    tab("s/$sessionId", SessionPage),
    tab("review", ProjectReview),
    tab("terminal", () => (
      <Suspense fallback={<p>Loading terminal…</p>}>
        <CheckoutTerminal />
      </Suspense>
    )),
    tab("runtime", CheckoutRuntime),
    // Ports and logs moved into the runtime tab.
    ...["ports", "logs"].map((path) =>
      createRoute({
        beforeLoad: ({ location }) => {
          throw redirect({
            href: location.pathname.replace(OLD_RUNTIME_TAB, "/runtime"),
            replace: true,
          });
        },
        getParentRoute: () => parent,
        path,
      })
    ),
  ];
};

const checkoutRoute = (path: string) => {
  const route = createRoute({
    component: CheckoutPage,
    getParentRoute: () => projectRoute,
    path,
  });
  return route.addChildren(checkoutTabs(route));
};

/** Project tabs from before worktrees came first; kept so old links still land somewhere sensible. */
const legacyRoute = (path: string, tab: Parameters<typeof legacyPath>[1]) =>
  createRoute({
    beforeLoad: ({ params }) => {
      const { projectId, target } = params as {
        projectId: string;
        target?: string;
      };
      throw redirect({
        href: legacyPath(projectId, tab, target),
        replace: true,
      });
    },
    getParentRoute: () => projectRoute,
    path,
  });

const routeTree = rootRoute.addChildren([
  shellRoute.addChildren([
    page("/", Overview),
    page("sessions", SessionsPage),
    page("usage", UsagePage),
    page("cleanup", CleanupPage),
    page("nodes", NodesPage),
    page("settings", SettingsPage),
    page("jira", JiraPage),
    page("jira/$key", JiraTicketPage),
    page("forgejo", ForgejoPage),
    page("forgejo/$owner/$repo/$number", ForgejoPullPage),
    projectRoute.addChildren([
      createRoute({
        component: ProjectOverview,
        getParentRoute: () => projectRoute,
        path: "/",
      }),
      createRoute({
        component: ProjectTask,
        getParentRoute: () => projectRoute,
        path: "t/$task",
      }),
      checkoutRoute("main"),
      checkoutRoute("w/$worktree"),
      legacyRoute("worktrees", "worktrees"),
      legacyRoute("review", "review"),
      legacyRoute("review/$target", "review"),
      legacyRoute("ports", "ports"),
      legacyRoute("logs", "logs"),
    ]),
    page("$", () => <NotFound />),
  ]),
]);

export const createAppRouter = (history?: RouterHistory) =>
  createRouter({
    defaultNotFoundComponent: () => <NotFound />,
    history,
    parseSearch,
    routeTree,
    stringifySearch,
  });

/** The matched pages; render inside a `RouterContextProvider`. */
export const App = () => <Matches />;
