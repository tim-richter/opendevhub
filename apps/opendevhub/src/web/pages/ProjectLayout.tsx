import { Outlet, useOutletContext, useParams } from "react-router";
import type { ProjectView } from "../../shared/types";
import { Page } from "../components/Page";
import { useDash } from "../DashboardContext";
import { NotFound } from "./NotFound";

/** Resolves the project from the URL; the overview, task and checkout pages render inside. */
export function ProjectLayout() {
  const { projectId } = useParams();
  const { snapshot } = useDash();
  const view = snapshot?.projects.find((v) => v.project.id === projectId);
  if (!view) return <NotFound what="Project" />;
  return (
    <Page>
      <Outlet context={view} />
    </Page>
  );
}

export const useProjectView = () => useOutletContext<ProjectView>();
