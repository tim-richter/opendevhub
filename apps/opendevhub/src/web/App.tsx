import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useParams } from "react-router";

import { legacyPath } from "./checkouts";
import { Shell } from "./layout/shell";
import {
  CheckoutPage,
  CheckoutRuntime,
  CheckoutSessions,
} from "./pages/CheckoutPage";
import { CleanupPage } from "./pages/CleanupPage";
import { ForgejoPage, ForgejoPullPage } from "./pages/ForgejoPage";
import { JiraPage, JiraTicketPage } from "./pages/JiraPage";
import { NodesPage } from "./pages/NodesPage";
import { NotFound } from "./pages/NotFound";
import { Overview } from "./pages/Overview";
import { ProjectReview } from "./pages/project-review";
import { ProjectLayout } from "./pages/ProjectLayout";
import { ProjectOverview } from "./pages/ProjectOverview";
import { ProjectTask } from "./pages/ProjectTask";
import { SessionsPage } from "./pages/SessionsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { UsagePage } from "./pages/UsagePage";

const CheckoutTerminal = lazy(() =>
  import("./pages/CheckoutTerminal").then((module) => ({
    default: module.CheckoutTerminal,
  }))
);

const checkoutTabs = (
  <>
    <Route index element={<CheckoutSessions />} />
    <Route path="review" element={<ProjectReview />} />
    <Route
      path="terminal"
      element={
        <Suspense fallback={<p>Loading terminal…</p>}>
          <CheckoutTerminal />
        </Suspense>
      }
    />
    <Route path="runtime" element={<CheckoutRuntime />} />
    <Route
      path="ports"
      element={<Navigate replace to="../runtime" relative="path" />}
    />
    <Route
      path="logs"
      element={<Navigate replace to="../runtime" relative="path" />}
    />
  </>
);

export const App = () => (
  <Routes>
    <Route element={<Shell />}>
      <Route index element={<Overview />} />
      <Route path="sessions" element={<SessionsPage />} />
      <Route path="usage" element={<UsagePage />} />
      <Route path="cleanup" element={<CleanupPage />} />
      <Route path="nodes" element={<NodesPage />} />
      <Route path="settings" element={<SettingsPage />} />
      <Route path="jira" element={<JiraPage />} />
      <Route path="jira/:key" element={<JiraTicketPage />} />
      <Route path="forgejo" element={<ForgejoPage />} />
      <Route
        path="forgejo/:owner/:repo/:number"
        element={<ForgejoPullPage />}
      />
      <Route path="p/:projectId" element={<ProjectLayout />}>
        <Route index element={<ProjectOverview />} />
        <Route path="t/:task" element={<ProjectTask />} />
        <Route path="main" element={<CheckoutPage />}>
          {checkoutTabs}
        </Route>
        <Route path="w/:worktree" element={<CheckoutPage />}>
          {checkoutTabs}
        </Route>
        <Route path="worktrees" element={<Legacy tab="worktrees" />} />
        <Route path="review" element={<Legacy tab="review" />} />
        <Route path="review/:target" element={<Legacy tab="review" />} />
        <Route path="ports" element={<Legacy tab="ports" />} />
        <Route path="logs" element={<Legacy tab="logs" />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Route>
  </Routes>
);

/** Project tabs from before worktrees came first; kept so old links still land somewhere sensible. */
const Legacy = ({ tab }: { tab: Parameters<typeof legacyPath>[1] }) => {
  const { projectId = "", target } = useParams();
  return <Navigate replace to={legacyPath(projectId, tab, target)} />;
};
