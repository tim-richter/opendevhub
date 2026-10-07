import { Outlet, useLocation, useOutletContext, useParams } from "react-router";

import type { ProjectView } from "../../shared/types";
import { Page } from "../components/Page";
import { useDash } from "../DashboardContext";
import { NotFound } from "./NotFound";

/** Resolves the project from the URL; the overview, task and checkout pages render inside. */
export const ProjectLayout = () => {
  const { projectId } = useParams();
  const { snapshot } = useDash();
  // Review lays diffs side by side, so it gets the viewport's whole width.
  const wide = useLocation().pathname.endsWith("/review");
  const view = snapshot?.projects.find((v) => v.project.id === projectId);
  if (!view) {
    return <NotFound what="Project" />;
  }
  return (
    <Page className={wide ? "max-w-none" : undefined}>
      <Outlet context={view} />
    </Page>
  );
};

export const useProjectView = () => useOutletContext<ProjectView>();
