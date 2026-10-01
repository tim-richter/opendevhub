import { Route, Routes } from "react-router";
import { Shell } from "./layout/Shell";
import { NotFound } from "./pages/NotFound";
import { Overview } from "./pages/Overview";
import { ProjectLogs, ProjectPage, ProjectPorts, ProjectSessions } from "./pages/ProjectPage";
import { ProjectWorktrees } from "./pages/ProjectWorktrees";
import { SessionsPage } from "./pages/SessionsPage";

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Overview />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="p/:projectId" element={<ProjectPage />}>
          <Route index element={<ProjectSessions />} />
          <Route path="worktrees" element={<ProjectWorktrees />} />
          <Route path="ports" element={<ProjectPorts />} />
          <Route path="logs" element={<ProjectLogs />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
