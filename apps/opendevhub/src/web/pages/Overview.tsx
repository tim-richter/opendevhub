import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { ProjectView } from "../../shared/types";
import { CheckIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Empty, muted, Page, PageHeader, Section, Segmented } from "../components/Page";
import { AllContainersMenu, projectFlags } from "../components/ProjectActions";
import { ResourceStat } from "../components/ResourceStat";
import { SessionList } from "../components/SessionList";
import { STATE_LABEL, StatusDot, TONE_LABEL, TONE_TEXT } from "../components/Status";
import { useDash } from "../DashboardContext";
import { formatUsage } from "../usage";
import { projectResources } from "../resources";
import { allSessions, matches, needsAttention, projectCounts, projectTone } from "../derive";

type Filter = "all" | "running" | "stopped";
const ACTIVE_LIMIT = 6;

export function Overview() {
  const { snapshot, newTask } = useDash();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  if (!snapshot) return null;

  const sessions = allSessions(snapshot);
  const attention = sessions.filter((e) => needsAttention(e.session.status));
  const active = sessions.filter((e) => e.session.status === "running");
  const runningProjects = snapshot.projects.filter((v) => v.runtime.containerState === "running");
  const ports = snapshot.projects.reduce((n, v) => n + projectCounts(v).ports, 0);

  const isUp = (v: ProjectView) => v.runtime.containerState !== "stopped";
  const tiles = [...snapshot.projects]
    .sort((a, b) => a.project.name.localeCompare(b.project.name))
    .filter((v) => (filter === "all" ? true : filter === "running" ? isUp(v) : !isUp(v)))
    .filter((v) => matches(query, v.project.name, v.project.path));

  return (
    <Page>
      <PageHeader
        title="Overview"
        description={
          <>
            {snapshot.roots.join(" · ") || "No roots configured"}
            {snapshot.usage && <p className="tabular-nums">Today {formatUsage(snapshot.usage.today)}</p>}
          </>
        }
        actions={
          <Button onClick={() => newTask()} title="New task (n)">
            <PlusIcon /> New task
          </Button>
        }
      />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Projects running" value={runningProjects.length} of={snapshot.projects.length} />
        <Stat label="Agents working" value={active.length} tone={active.length > 0 ? "running" : undefined} />
        <Stat label="Need you" value={attention.length} tone={attention.length > 0 ? "attention" : undefined} />
        <Stat label="Forwarded ports" value={ports} />
      </section>

      {attention.length > 0 ? (
        <Section title="Needs you" hint="Agents blocked on a permission or a question" attention>
          <SessionList entries={attention} showProject />
        </Section>
      ) : (
        snapshot.projects.length > 0 && (
          <p className="flex items-center gap-1.5 font-medium text-ok">
            <CheckIcon className="size-4" /> No agent is waiting on you.
          </p>
        )
      )}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="font-semibold">Projects</h2>
          <Segmented
            label="Show projects"
            value={filter}
            onChange={setFilter}
            options={(["all", "running", "stopped"] as const).map((f) => ({ id: f, label: f[0]!.toUpperCase() + f.slice(1) }))}
          />
          {snapshot.projects.length > 6 && (
            <Input className="ml-auto w-56 max-md:w-full" placeholder="Filter…" value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
        </div>
        {snapshot.projects.length === 0 ? (
          <Empty title="No projects yet">
            <p className={muted}>No folder with a devcontainer was found under the configured roots.</p>
          </Empty>
        ) : tiles.length === 0 ? (
          <p className={muted}>No projects match.</p>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {tiles.map((v) => (
              <ProjectTile key={v.project.id} view={v} />
            ))}
          </ul>
        )}
      </section>

      {active.length > 0 && (
        <Section
          title="Working now"
          action={
            active.length > ACTIVE_LIMIT && (
              <Link to="/sessions?status=running" className="text-sm text-muted-foreground hover:text-foreground">
                All {active.length} →
              </Link>
            )
          }
        >
          <SessionList entries={active.slice(0, ACTIVE_LIMIT)} showProject />
        </Section>
      )}
    </Page>
  );
}

function Stat(props: { label: string; value: number; of?: number; tone?: "attention" | "running" }) {
  return (
    <Card className={cn("gap-0.5 px-4 py-3", props.tone === "attention" && "border-attention/50")}>
      <span
        className={cn(
          "text-2xl font-semibold tracking-tight tabular-nums",
          props.tone === "attention" && "text-attention",
          props.tone === "running" && "text-running",
        )}
      >
        {props.value}
        {props.of !== undefined && <span className="text-base font-medium text-muted-foreground"> / {props.of}</span>}
      </span>
      <span className="text-xs text-muted-foreground">{props.label}</span>
    </Card>
  );
}

function ProjectTile({ view }: { view: ProjectView }) {
  const navigate = useNavigate();
  const { snapshot } = useDash();
  const resources = projectResources(snapshot, view);
  const tone = projectTone(view);
  const c = projectCounts(view);
  const { running } = projectFlags(view, false);
  const to = `/p/${encodeURIComponent(view.project.id)}`;
  const status = view.runtime.containerState === "running" ? TONE_LABEL[tone] : STATE_LABEL[view.runtime.containerState];

  return (
    <li>
      <Card
        className={cn(
          "h-full min-w-0 cursor-pointer gap-2 px-4 py-3 transition-[border-color,box-shadow] hover:border-foreground/20 hover:shadow-md",
          tone === "attention" && "border-attention/60",
          tone === "off" && "bg-muted/40",
        )}
        onClick={() => void navigate(to)}
      >
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot tone={tone} />
          <Link to={to} className="truncate font-semibold hover:underline" onClick={(e) => e.stopPropagation()}>
            {view.project.name}
          </Link>
          <span className={cn("ml-auto text-xs whitespace-nowrap", TONE_TEXT[tone])}>{status}</span>
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground" title={view.project.path}>
          {view.project.path}
        </p>
        <div className="flex min-h-5 flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
          {c.attention > 0 && <span className="font-semibold text-attention">{c.attention} need you</span>}
          {running ? (
            <>
              <span>{c.running} working</span>
              <span>{c.idle} idle</span>
              <span>
                {c.ports} {c.ports === 1 ? "port" : "ports"}
              </span>
            </>
          ) : (
            view.runtime.containerState === "stopped" && <span>Container not running</span>
          )}
          {resources && <ResourceStat {...resources} className="ml-auto" />}
        </div>
        {view.runtime.error && (
          <p className="truncate text-xs text-destructive" title={view.runtime.error}>
            {view.runtime.error}
          </p>
        )}
        <div className="mt-auto flex cursor-default items-center gap-2 pt-1" onClick={(e) => e.stopPropagation()}>
          <div className="ml-auto">
            <AllContainersMenu view={view} />
          </div>
        </div>
      </Card>
    </li>
  );
}
