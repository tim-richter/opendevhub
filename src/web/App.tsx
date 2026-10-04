import { Navigate, Route, Routes, useParams } from "react-router";
import { legacyPath } from "./checkouts";
import { Shell } from "./layout/Shell";
import { CheckoutLogs, CheckoutPage, CheckoutPorts, CheckoutSessions } from "./pages/CheckoutPage";
import { NotFound } from "./pages/NotFound";
import { Overview } from "./pages/Overview";
import { ProjectLayout } from "./pages/ProjectLayout";
import { ProjectOverview } from "./pages/ProjectOverview";
import { ProjectReview } from "./pages/ProjectReview";
import { ProjectTask } from "./pages/ProjectTask";
import { SessionsPage } from "./pages/SessionsPage";

const checkoutTabs = (
  <>
    <Route index element={<CheckoutSessions />} />
    <Route path="review" element={<ProjectReview />} />
    <Route path="ports" element={<CheckoutPorts />} />
    <Route path="logs" element={<CheckoutLogs />} />
  </>
);

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="sessions" element={<SessionsPage />} />
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
}

/** Project tabs from before worktrees came first; kept so old links still land somewhere sensible. */
function Legacy({ tab }: { tab: Parameters<typeof legacyPath>[1] }) {
  const { projectId = "", target } = useParams();
  return <Navigate replace to={legacyPath(projectId, tab, target)} />;
}
