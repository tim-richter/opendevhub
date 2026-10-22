import { Button } from "@opendevhub/ui/button";
import { PencilIcon, PlayIcon, TicketIcon } from "lucide-react";
import { useState } from "react";

import { modelShortName } from "../../../shared/tasks";
import type { ProjectView, TaskPlan, TaskView } from "../../../shared/types";
import { archiveTask } from "../../api";
import { Chip, muted, Section } from "../../components/page";
import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";
import { ActivityButton } from "../activity/activity-button";

/** A draft's plan in words: where it runs and its variants' models and agents. */
export const planLines = (plan: TaskPlan | undefined): string[] => {
  if (!plan) {
    return ["One variant on the project's default model, in a new worktree."];
  }
  let where = "In the main checkout";
  if (plan.where === "worktree") {
    where = `In a new worktree${plan.environment === "isolated" ? " with its own container" : ""}${plan.node ? ` on ${plan.node}` : ""}`;
  } else if (plan.where === "existing") {
    where = `In ${plan.directory ?? "an existing worktree"}${plan.environment === "isolated" ? " with its own container" : ""}`;
  }
  const variants = plan.variants.map((v, i) => {
    const model = v.model ? modelShortName(v.model) : "default model";
    return `Variant ${i + 1}: ${model}${v.agent ? `, agent ${v.agent}` : ""}`;
  });
  return [
    `${where}${plan.base ? `, from ${plan.base}` : ""}.`,
    ...specLine(plan.spec),
    ...variants,
  ];
};

const specLine = (spec: TaskPlan["spec"]): string[] => {
  if (spec === "explore") {
    return [
      "Starts by exploring with the agent, then proposes an OpenSpec change.",
    ];
  }
  return spec ? ["Starts by proposing an OpenSpec change."] : [];
};

/**
 * A draft task's page: its brief, links and plan instead of the tabs, with Start (the New task dialog, filled from the
 * draft, adds its variants to this task) and Edit (the same dialog, saving the draft without starting it).
 */
export const DraftTask = ({
  view,
  task,
}: {
  view: ProjectView;
  task: TaskView;
}) => {
  const { newTask, report } = useDash();
  const [busy, setBusy] = useState(false);
  const open = (mode: "start" | "edit") =>
    newTask(view.project.id, {
      draft: { mode, task: task.id },
      ...(task.brief ? { prompt: task.brief } : {}),
      title: task.title,
      ...(task.jira ? { jira: task.jira } : {}),
      ...(task.plan ? { plan: task.plan } : {}),
    });
  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className={muted}>
        <Link
          to={`/p/${encodeURIComponent(view.project.id)}`}
          className="hover:text-foreground hover:underline"
        >
          {view.project.name}
        </Link>{" "}
        › Draft
      </nav>
      <div className="flex flex-wrap items-baseline gap-2.5">
        <h2 className="text-lg font-semibold">{task.title || "Task"}</h2>
        <Chip>Task</Chip>
        <Chip variant="outline">draft</Chip>
        {task.ticket && (
          <Chip variant="outline" asChild>
            <Link to={`/jira/${encodeURIComponent(task.ticket.key)}`}>
              <TicketIcon className="size-3" /> {task.ticket.key}
              {task.ticket.status && ` · ${task.ticket.status}`}
            </Link>
          </Chip>
        )}
        <span className="ml-auto flex items-center gap-1">
          <ActivityButton
            filter={{ taskId: task.id }}
            subject={task.title || "Task"}
            empty="Nothing recorded for this task yet."
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            title="Hide this draft"
            onClick={() => {
              setBusy(true);
              void archiveTask(view.project.id, task.id)
                .catch(report)
                .finally(() => setBusy(false));
            }}
          >
            Archive
          </Button>
          <Button variant="outline" size="sm" onClick={() => open("edit")}>
            <PencilIcon /> Edit
          </Button>
          <Button size="sm" onClick={() => open("start")}>
            <PlayIcon /> Start
          </Button>
        </span>
      </div>
      <Section title="Brief">
        <div className="px-4 py-3">
          {task.brief ? (
            <p className="text-sm break-words whitespace-pre-wrap">
              {task.brief}
            </p>
          ) : (
            <p className={muted}>No brief yet. Edit the draft to write one.</p>
          )}
        </div>
      </Section>
      <Section title="Plan">
        <div className="px-4 py-3">
          <ul className="flex flex-col gap-1 text-sm">
            {planLines(task.plan).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </Section>
    </div>
  );
};
