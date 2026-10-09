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

import {
  CheckoutPage,
  CheckoutRuntime,
  CheckoutSessions,
} from "./features/checkouts/checkout-page";
import { legacyPath } from "./features/checkouts/checkouts";
import { CleanupPage } from "./features/cleanup/cleanup-page";
import { ForgejoPage, ForgejoPullPage } from "./features/forgejo/forgejo-page";
import { JiraPage, JiraTicketPage } from "./features/jira/jira-page";
import { NodesPage } from "./features/nodes/nodes-page";
import { Overview } from "./features/projects/overview";
import { ProjectLayout } from "./features/projects/project-layout";
import { ProjectOverview } from "./features/projects/project-overview";
import { ProjectReview } from "./features/review/project-review";
import { SessionPage } from "./features/sessions/session-page";
import { SessionsPage } from "./features/sessions/sessions-page";
import { SettingsPage } from "./features/settings/settings-page";
import { ProjectTask } from "./features/tasks/project-task";
import { UsagePage } from "./features/usage/usage-page";
import { parseSearch, stringifySearch } from "./routing";
import { NotFound } from "./shell/not-found";
import { Shell } from "./shell/shell";

const CheckoutTerminal = lazy(() =>
  import("./features/checkouts/checkout-terminal").then((module) => ({
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
