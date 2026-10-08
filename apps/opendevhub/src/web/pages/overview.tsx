import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import type { ProjectView, SessionStatus } from "../../shared/types";
import { checkoutPath } from "../checkouts";
import { Empty, muted, Page, Section, Segmented } from "../components/page";
import { AllContainersMenu } from "../components/project-actions";
import { ResourceStat } from "../components/resource-stat";
import { SessionList } from "../components/session-list";
import {
  STATE_LABEL,
  StatusDot,
  TONE_LABEL,
  TONE_TEXT,
} from "../components/status";
import { Tip } from "../components/tip";
import { useDash } from "../dashboard-context";
import {
  allSessions,
  compareSessions,
  matches,
  needsAttention,
  projectCounts,
  projectTone,
} from "../derive";
import type { ProjectCounts } from "../derive";
import { projectResources } from "../resources";
import { formatCost } from "../tasks";
import { formatUsage } from "../usage";

type Filter = "all" | "running" | "stopped";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  // Stopped, starting and broken containers alike.
  { id: "stopped", label: "Not running" },
];
const ACTIVE_LIMIT = 6;
const FILTER_THRESHOLD = 6;
/** More sessions than this and a project's lights end in a "+n". */
const LIGHT_LIMIT = 12;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export const Overview = () => {
  const { snapshot, newTask, openAddProject, rescan, scanning } = useDash();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  if (!snapshot) {
    return null;
  }

  const sessions = allSessions(snapshot);
  const attention = sessions.filter((e) => needsAttention(e.session.status));
  const active = sessions.filter((e) => e.session.status === "running");
  const activeProjects = new Set(active.map((e) => e.view.project.id)).size;
  const upProjects = snapshot.projects.filter(
    (v) => v.runtime.containerState === "running"
  ).length;

  const isUp = (v: ProjectView) => v.runtime.containerState === "running";
  const rows = [...snapshot.projects]
    .toSorted((a, b) => a.project.name.localeCompare(b.project.name))
    .filter((v) => {
      if (filter === "all") {
        return true;
      }
      if (filter === "running") {
        return isUp(v);
      }
      return !isUp(v);
    })
    .filter((v) => matches(query, v.project.name, v.project.path));

  const hasProjects = snapshot.projects.length > 0;
  let headline = "Nothing is waiting on you";
  if (!hasProjects) {
    headline = "No projects yet";
  } else if (attention.length > 0) {
    headline = `${plural(attention.length, "agent is", "agents are")} waiting on you`;
  }

  return (
    <Page>
      <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 flex-col gap-2">
          <h1 className="sr-only">Overview</h1>
          <p
            className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-balance"
            aria-live="polite"
          >
            {attention.length > 0 && (
              <span
                className="bg-attention inline-block size-2.5 shrink-0 rounded-full"
                aria-hidden
              />
            )}
            {headline}
          </p>
          {hasProjects && (
            <p className="text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 tabular-nums">
              <span>
                {plural(active.length, "agent")} working
                {activeProjects > 0 &&
                  ` in ${plural(activeProjects, "project")}`}
              </span>
              <span>
                {upProjects} of {plural(snapshot.projects.length, "container")}{" "}
                running
              </span>
              {snapshot.usage && (
                <Link
                  to="/usage"
                  className="hover:text-foreground underline-offset-4 hover:underline"
                  title={formatUsage(snapshot.usage.today)}
                >
                  {formatCost(snapshot.usage.today.cost)} spent today
                </Link>
              )}
            </p>
          )}
        </div>
        {hasProjects && (
          <Button
            onClick={() => newTask()}
            title="New task (n)"
            className="max-md:w-full"
          >
            <PlusIcon /> New task
          </Button>
        )}
      </header>

      {attention.length > 0 && (
        <Section
          title="Waiting on you"
          hint="Answer here, or open the session in opencode"
          attention
        >
          <SessionList entries={attention} showProject />
        </Section>
      )}

      <section className="flex flex-col gap-3" aria-labelledby="projects">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="projects" className="font-semibold">
            Projects
          </h2>
          {hasProjects && (
            <Segmented
              label="Show projects"
              value={filter}
              onChange={setFilter}
              options={FILTERS}
            />
          )}
          {snapshot.projects.length > FILTER_THRESHOLD && (
            <Input
              className="ml-auto w-56 max-md:w-full"
              placeholder="Filter projects"
              aria-label="Filter projects"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
        </div>
        {hasProjects ? (
          <ProjectRack views={rows} />
        ) : (
          <Empty title="Add your first project">
            <p className={cn(muted, "max-w-md text-balance")}>
              No folder with a devcontainer was found under{" "}
              <code className="font-mono text-xs">
                {snapshot.roots.join(", ") || "the configured roots"}
              </code>
              . Add a git repo and opendevhub sets up its devcontainer, or start
              opendevhub with <code className="font-mono text-xs">--root</code>{" "}
              pointing at your code.
            </p>
            <div className="mt-2 flex flex-wrap justify-center gap-2">
              <Button onClick={openAddProject}>
                <PlusIcon /> Add project
              </Button>
              <Button variant="outline" disabled={scanning} onClick={rescan}>
                <RefreshCwIcon /> {scanning ? "Scanning…" : "Rescan"}
              </Button>
            </div>
          </Empty>
        )}
      </section>

      {active.length > 0 && (
        <Section
          title="Working now"
          action={
            active.length > ACTIVE_LIMIT && (
              <Link
                to="/sessions?status=running"
                className="text-muted-foreground hover:text-foreground text-sm"
              >
                See all {active.length}
              </Link>
            )
          }
        >
          <SessionList entries={active.slice(0, ACTIVE_LIMIT)} showProject />
        </Section>
      )}
    </Page>
  );
};

const ProjectRack = ({ views }: { views: ProjectView[] }) => {
  if (views.length === 0) {
    return <p className={muted}>No projects match.</p>;
  }
  return (
    <ul className="bg-card overflow-hidden rounded-lg border">
      <li
        aria-hidden
        className={cn(
          "text-muted-foreground grid items-center gap-x-5 border-b px-4 py-2 text-xs max-md:hidden",
          RACK_COLUMNS
        )}
      >
        <span>Project</span>
        <span>Sessions</span>
        <span>Status</span>
        <span>Ports</span>
        <span className="justify-self-end">Usage</span>
        <span />
      </li>
      {views.map((v) => (
        <ProjectRow key={v.project.id} view={v} />
      ))}
    </ul>
  );
};

const RACK_COLUMNS = "md:grid-cols-[minmax(0,1fr)_9rem_8rem_4.5rem_11rem_2rem]";

const LIGHT: Record<SessionStatus, string> = {
  idle: "bg-muted-foreground/30",
  "needs-answer": "bg-attention",
  "needs-permission": "bg-attention",
  running: "bg-running",
};

/** One light per session, the ones waiting on you first, so a glance down the list shows every agent. */
const AgentLights = ({
  view,
  counts,
}: {
  view: ProjectView;
  counts: ProjectCounts;
}) => {
  const ordered = view.sessions.toSorted(compareSessions);
  const shown = ordered.slice(0, LIGHT_LIMIT);
  const parts = [
    counts.attention > 0 && `${counts.attention} waiting on you`,
    counts.running > 0 && `${counts.running} working`,
    counts.idle > 0 && `${counts.idle} idle`,
  ].filter(Boolean);
  const label = `Sessions: ${parts.join(", ")}`;
  if (shown.length === 0) {
    return null;
  }
  return (
    <Tip label={label}>
      <span
        className="inline-flex h-5 items-center gap-1"
        role="img"
        aria-label={label}
      >
        {shown.map((s) => (
          <span
            key={s.id}
            className={cn("h-4 w-1.5 rounded-full", LIGHT[s.status])}
          />
        ))}
        {ordered.length > LIGHT_LIMIT && (
          <span className="text-muted-foreground ml-0.5 text-xs tabular-nums">
            +{ordered.length - LIGHT_LIMIT}
          </span>
        )}
      </span>
    </Tip>
  );
};

const ProjectRow = ({ view }: { view: ProjectView }) => {
  const { snapshot } = useDash();
  const resources = projectResources(snapshot, view);
  const tone = projectTone(view);
  const counts = projectCounts(view);
  const to = `/p/${encodeURIComponent(view.project.id)}`;
  const status =
    view.runtime.containerState === "running"
      ? TONE_LABEL[tone]
      : STATE_LABEL[view.runtime.containerState];

  return (
    <li
      className={cn(
        "hover:bg-muted/50 relative grid items-center gap-x-5 gap-y-1.5 border-t px-4 py-3 first:border-t-0",
        "grid-cols-[minmax(0,1fr)_auto_auto]",
        RACK_COLUMNS,
        tone === "attention" && "shadow-[inset_3px_0_var(--attention)]",
        tone === "error" && "shadow-[inset_3px_0_var(--destructive)]"
      )}
    >
      <div className="flex min-w-0 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={tone} />
          {/* Stretched over the row, so the whole row opens the project. */}
          <Link
            to={to}
            className="truncate font-semibold after:absolute after:inset-0 hover:underline"
          >
            {view.project.name}
          </Link>
        </div>
        <p
          className="text-muted-foreground truncate pl-4 text-xs"
          title={view.project.path}
        >
          {view.runtime.error ? (
            <span
              className="text-destructive relative"
              title={view.runtime.error}
            >
              {view.runtime.error}
            </span>
          ) : (
            view.project.path
          )}
        </p>
      </div>
      <div className="relative max-md:order-last max-md:col-span-full max-md:pl-4">
        <AgentLights view={view} counts={counts} />
      </div>
      <span
        className={cn(
          "text-sm whitespace-nowrap max-md:col-start-2 max-md:row-start-1 max-md:justify-self-end",
          TONE_TEXT[tone]
        )}
      >
        {status}
      </span>
      <span className="text-muted-foreground text-xs whitespace-nowrap tabular-nums max-md:hidden">
        {counts.ports > 0 && (
          <Link
            to={checkoutPath(view.project.id, "", "runtime")}
            className="hover:text-foreground relative hover:underline"
          >
            {plural(counts.ports, "port")}
          </Link>
        )}
      </span>
      <span className="relative justify-self-end max-md:hidden">
        {resources && <ResourceStat {...resources} />}
      </span>
      <div className="relative justify-self-end max-md:col-start-3 max-md:row-start-1">
        <AllContainersMenu view={view} />
      </div>
    </li>
  );
};
