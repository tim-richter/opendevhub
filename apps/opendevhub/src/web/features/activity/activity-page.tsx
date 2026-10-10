import { Choice } from "../../components/choice";
import { Page, PageHeader } from "../../components/page";
import { useDash } from "../../dashboard-context";
import { useSearchParams } from "../../routing";
import { ActivityFeed } from "./activity-feed";

/** What happened across every project, or in one, newest first. */
export const ActivityPage = () => {
  const { snapshot } = useDash();
  const [params, setParams] = useSearchParams();
  const projects = snapshot?.projects.map((v) => v.project) ?? [];
  const selected = params.get("project") ?? "";
  const projectId = projects.some((p) => p.id === selected)
    ? selected
    : undefined;
  return (
    <Page>
      <PageHeader
        title="Activity"
        description="Tasks started, variants failed, branches published, pull requests linked and reviews run, newest first."
        actions={
          projects.length > 1 && (
            <Choice
              label="Project"
              value={projectId ?? ""}
              onChange={(value) =>
                setParams(value ? { project: value } : {}, { replace: true })
              }
              options={[
                { label: "All projects", value: "" },
                ...projects.map((p) => ({ label: p.name, value: p.id })),
              ]}
            />
          )
        }
      />
      <ActivityFeed
        key={projectId ?? ""}
        filter={projectId ? { projectId } : {}}
        showProject={!projectId}
        empty="Nothing has happened yet. Start a task and it shows up here."
      />
    </Page>
  );
};
