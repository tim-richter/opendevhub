import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import type { Usage, UsageReport } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fetchUsage } from "../api";
import { UsageChart } from "../components/LazyUsageChart";
import { Empty, muted, Page, PageHeader, Segmented } from "../components/Page";
import { useDash } from "../DashboardContext";
import { formatCost, formatTokens } from "../tasks";
import { dayLabel, projectName, share, shiftDay } from "../usage";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function UsagePage() {
  const { snapshot } = useDash();
  const [params, setParams] = useSearchParams();
  const asked = params.get("day");
  const [report, setReport] = useState<UsageReport>();
  const [error, setError] = useState<string>();
  const [view, setView] = useState<"chart" | "table">("chart");
  const [chosenMetric, setMetric] = useState<"cost" | "tokens">();
  const live = snapshot?.usage;
  // A booking changes today's total, so refetch then to keep the page current while agents work.
  const liveKey = live ? `${live.today.cost}:${live.today.tokens}` : "";

  useEffect(() => {
    if (!live) return;
    let current = true;
    fetchUsage(asked && DAY.test(asked) ? asked : undefined).then(
      (r) => current && (setReport(r), setError(undefined)),
      (err: Error) => current && setError(err.message),
    );
    return () => {
      current = false;
    };
  }, [asked, liveKey, !!live]);

  if (!snapshot) return null;
  const header = <PageHeader title="Usage" description="What the agents spent, from opendevhub's ledger. Days follow this machine's clock." />;
  if (!live) {
    return (
      <Page>
        {header}
        <Empty title="Usage tracking is off">
          <p className={muted}>opendevhub couldn't open its usage ledger; the server log says why.</p>
        </Empty>
      </Page>
    );
  }
  if (!report) {
    return (
      <Page>
        {header}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </Page>
    );
  }

  const today = report.days.at(-1)?.day ?? report.day;
  // Models that report no price (e.g. on a subscription) leave cost at zero; tokens are the useful measure then.
  const metric = chosenMetric ?? (report.total.cost > 0 ? "cost" : "tokens");
  const setDay = (day: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (day === today) next.delete("day");
        else next.set("day", day);
        return next;
      },
      { replace: true },
    );

  return (
    <Page className={cn(error && "opacity-60")}>
      {header}
      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2">
        <Tile label="All time" usage={report.total} />
        <Tile label="Today" usage={report.today} />
      </div>

      <Card className="gap-3 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Last {report.days.length} days</h2>
          <div className="flex flex-wrap items-center gap-2">
            {view === "chart" && (
              <Segmented
                label="Measure"
                value={metric}
                onChange={setMetric}
                options={[
                  { id: "cost", label: "Cost" },
                  { id: "tokens", label: "Tokens" },
                ]}
              />
            )}
            <Segmented
              label="Show as"
              value={view}
              onChange={setView}
              options={[
                { id: "chart", label: "Chart" },
                { id: "table", label: "Table" },
              ]}
            />
          </div>
        </div>
        {view === "chart" ? (
          <UsageChart days={report.days} metric={metric} selected={report.day} onSelect={setDay} />
        ) : (
          <DaysTable days={report.days} selected={report.day} onSelect={setDay} />
        )}
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Previous day" onClick={() => setDay(shiftDay(report.day, -1))}>
            <ChevronLeftIcon />
          </Button>
          <Input
            type="date"
            aria-label="Day"
            className="w-40"
            max={today}
            value={report.day}
            onChange={(e) => DAY.test(e.target.value) && setDay(e.target.value)}
          />
          <Button variant="outline" size="icon" aria-label="Next day" disabled={report.day >= today} onClick={() => setDay(shiftDay(report.day, 1))}>
            <ChevronRightIcon />
          </Button>
          <Button variant="ghost" disabled={report.day === today} onClick={() => setDay(today)}>
            Today
          </Button>
        </div>
        <Card className="gap-0 py-0">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-3">
            <h2 className="font-semibold">{dayLabel(report.day, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</h2>
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatCost(report.dayTotal.cost)} · {formatTokens(report.dayTotal.tokens)} tokens
            </span>
          </div>
          {report.projects.length === 0 ? (
            <p className={cn(muted, "px-4 py-6 text-center")}>Nothing was spent this day.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="px-4">Project</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                  <TableHead className="text-right">Tokens</TableHead>
                  <TableHead className="px-4 text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.projects.map((p) => (
                  <TableRow key={p.projectId}>
                    <TableCell className="px-4">{projectName(snapshot, p.projectId)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCost(p.cost)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatTokens(p.tokens)}</TableCell>
                    <TableCell className="px-4 text-right text-muted-foreground tabular-nums">{share(p[metric], report.dayTotal[metric])}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </section>
    </Page>
  );
}

function Tile(props: { label: string; usage: Usage }) {
  return (
    <Card className="gap-1 px-4 py-4">
      <span className="text-sm text-muted-foreground">{props.label}</span>
      <span className="text-3xl font-semibold tracking-tight">{formatCost(props.usage.cost)}</span>
      <span className="text-sm text-muted-foreground">{formatTokens(props.usage.tokens)} tokens</span>
    </Card>
  );
}

/** The chart's table twin: newest day first. */
function DaysTable(props: { days: UsageReport["days"]; selected: string; onSelect: (day: string) => void }) {
  return (
    <div className="max-h-[220px] overflow-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Day</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...props.days].reverse().map((d) => (
            <TableRow key={d.day} data-state={d.day === props.selected ? "selected" : undefined}>
              <TableCell>
                <button className="hover:underline" onClick={() => props.onSelect(d.day)}>
                  {dayLabel(d.day)}
                </button>
              </TableCell>
              <TableCell className="text-right tabular-nums">{formatCost(d.cost)}</TableCell>
              <TableCell className="text-right tabular-nums">{formatTokens(d.tokens)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
