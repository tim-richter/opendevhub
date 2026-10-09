import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

import type { SessionStatus } from "../../../shared/types";
import { Choice } from "../../components/choice";
import {
  Empty,
  muted,
  Page,
  PageHeader,
  Segmented,
} from "../../components/page";
import { useDash } from "../../dashboard-context";
import { allSessions, matches, needsAttention } from "../../derive";
import { useSearchParams } from "../../routing";
import { SessionList } from "./session-list";

type StatusFilter = "all" | "attention" | SessionStatus;
const CHIPS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "attention", label: "Needs you" },
  { id: "running", label: "Working" },
  { id: "idle", label: "Idle" },
];

export const SessionsPage = () => {
  const { snapshot } = useDash();
  const [params, setParams] = useSearchParams();
  if (!snapshot) {
    return null;
  }

  const status = (params.get("status") ?? "all") as StatusFilter;
  const project = params.get("project") ?? "";
  const q = params.get("q") ?? "";
  const set = (key: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value && value !== "all") {
          next.set(key, value);
        } else {
          next.delete(key);
        }
        return next;
      },
      { replace: true }
    );

  const all = allSessions(snapshot);
  const byStatus = (f: StatusFilter) =>
    all.filter((e) => {
      if (f === "all") {
        return true;
      }
      if (f === "attention") {
        return needsAttention(e.session.status);
      }
      return e.session.status === f;
    });
  const entries = byStatus(status)
    .filter((e) => !project || e.view.project.id === project)
    .filter((e) => matches(q, e.session.title, e.view.project.name));
  const withSessions = snapshot.projects.filter((v) => v.sessions.length > 0);

  const filtered =
    entries.length === 0 ? (
      <p className={muted}>No sessions match these filters.</p>
    ) : (
      <Card className="overflow-hidden py-0">
        <SessionList entries={entries} showProject />
      </Card>
    );
  return (
    <Page>
      <PageHeader
        title="Sessions"
        description="Every opencode session across running projects"
      />

      <div className="flex flex-wrap items-center gap-2.5">
        <Segmented
          label="Status"
          value={status}
          onChange={(id) => set("status", id)}
          options={CHIPS.map((c) => ({
            id: c.id,
            label: (
              <>
                {c.label}{" "}
                <span className="text-muted-foreground text-xs tabular-nums">
                  {byStatus(c.id).length}
                </span>
              </>
            ),
          }))}
        />
        <Choice
          label="Project"
          size="default"
          value={project}
          onChange={(v) => set("project", v)}
          options={[
            { label: "All projects", value: "" },
            ...withSessions.map((v) => ({
              label: v.project.name,
              value: v.project.id,
            })),
          ]}
        />
        <Input
          className="w-56 max-md:w-full md:ml-auto"
          placeholder="Search titles…"
          value={q}
          onChange={(e) => set("q", e.target.value)}
        />
      </div>

      {all.length === 0 ? (
        <Empty title="No sessions">
          <p className={muted}>
            Start a project and open opencode to create one.
          </p>
        </Empty>
      ) : (
        filtered
      )}
    </Page>
  );
};
