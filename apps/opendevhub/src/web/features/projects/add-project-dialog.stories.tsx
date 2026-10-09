import { useEffect } from "react";

import preview from "../../../../.storybook/preview";
import { useDash } from "../../dashboard-context";
import { pending } from "../../mocks/handlers";
import { mockApi } from "../../mocks/story";
import { AddProjectDialog } from "./add-project-dialog";

/** Opens the dialog the way the "+" next to Projects does. */
const OpenAddProject = () => {
  const { openAddProject } = useDash();
  useEffect(openAddProject, [openAddProject]);
  return <AddProjectDialog />;
};

const meta = preview.meta({
  component: OpenAddProject,
  title: "Components/AddProjectDialog",
});

/** Repos under the roots without a devcontainer, each with a detected stack. */
export const Default = meta.story();

export const Scanning = meta.story({
  beforeEach: mockApi({}, pending("get", "/api/onboarding/candidates")),
});
