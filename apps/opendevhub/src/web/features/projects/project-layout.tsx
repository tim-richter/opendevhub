import { Outlet, useParams } from "@tanstack/react-router";
import { createContext, useContext } from "react";

import type { ProjectView } from "../../../shared/types";
import { Page } from "../../components/page";
import { useDash } from "../../dashboard-context";
import { NotFound } from "../../shell/not-found";

const ProjectViewContext = createContext<ProjectView | undefined>(undefined);

/** Resolves the project from the URL; the overview, task and checkout pages render inside. */
export const ProjectLayout = () => {
  const { projectId } = useParams({ strict: false });
  const { snapshot } = useDash();
  const view = snapshot?.projects.find((v) => v.project.id === projectId);
  if (!view) {
    return <NotFound what="Project" />;
  }
  return (
    <Page>
      <ProjectViewContext value={view}>
        <Outlet />
      </ProjectViewContext>
    </Page>
  );
};

export const useProjectView = (): ProjectView => {
  const view = useContext(ProjectViewContext);
  if (!view) {
    throw new Error("useProjectView must be used inside ProjectLayout");
  }
  return view;
};
