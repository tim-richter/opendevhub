import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { CleanupItem, CleanupOutcome, CleanupPlan } from "../../shared/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { applyCleanup, fetchCleanup, postAction } from "../api";
import { branchGroups, initialSelection, isRisky, riskyNotes, selectionSummary, toggleAll } from "../cleanup";
import { Chip, Empty, muted, Note, Page, PageHeader, Section } from "../components/Page";
import { useDash } from "../DashboardContext";
import { formatMemory } from "../resources";

function ago(at: number, now: number): string {
  const min = Math.round((now - at) / 60_000);
  return min < 1 ? "scanned just now" : `scanned ${min} min ago`;
}

function Outcome({ result }: { result?: CleanupOutcome }) {
  if (!result) return null;
  const tone = result.outcome === "removed" ? "text-muted-foreground" : result.outcome === "failed" ? "text-destructive" : "text-attention";
  return <span className={cn("text-xs", tone)}>{result.outcome}{result.message ? `: ${result.message}` : ""}</span>;
}

function Row(props: { item: CleanupItem; selected: boolean; onToggle: (on: boolean) => void; result?: CleanupOutcome; children: ReactNode }) {
  return (
    <label className="flex items-center gap-3 border-b px-4 py-2 last:border-b-0">
      <Checkbox checked={props.selected} onCheckedChange={(v) => props.onToggle(v === true)} />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{props.children}</div>
      <Outcome result={props.result} />
    </label>
  );
}

export function CleanupPage() {
  const { report } = useDash();
  const [plan, setPlan] = useState<CleanupPlan>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Map<string, CleanupOutcome>>(new Map());
  const [freed, setFreed] = useState<number>();
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const next = await fetchCleanup();
      setPlan(next);
      setSelected(initialSelection(next));
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const apply = async () => {
    if (!plan) return;
    setConfirming(false);
    setApplying(true);
    try {
      const result = await applyCleanup(plan.items.filter((i) => selected.has(i.id)));
      setResults(new Map(result.results.map((r) => [r.id, r])));
      setFreed(result.freedBytes);
      await scan();
    } catch (err) {
      report(err);
    } finally {
      setApplying(false);
    }
  };

  const header = (
    <PageHeader
      title="Cleanup"
      description="Merged branches with their worktrees, containers opendevhub no longer needs, and unused images. Nothing is removed until you confirm."
      actions={
        <>
          {plan && <span className={muted}>{ago(plan.scannedAt, Date.now())}</span>}
          <Button variant="outline" onClick={() => void scan()} disabled={scanning || applying}>
            {scanning ? "Scanning…" : "Scan"}
          </Button>
          <Button onClick={() => setConfirming(true)} disabled={!plan || selected.size === 0 || applying}>
            {applying ? "Cleaning up…" : "Clean up selected"}
          </Button>
        </>
      }
    />
  );

  if (!plan) {
    return (
      <Page>
        {header}
        {error ? <p className="text-sm text-destructive">{error}</p> : <p className={muted}>Scanning every project…</p>}
      </Page>
    );
  }

  const containers = plan.items.filter((i) => i.kind === "container");
  const images = plan.items.filter((i) => i.kind === "image");
  const groups = branchGroups(plan);
  const notes = riskyNotes(plan, selected);
  const selectAll = (kind: CleanupItem["kind"]) => {
    const rows = plan.items.filter((i) => i.kind === kind && !isRisky(i));
    const allOn = rows.length > 0 && rows.every((i) => selected.has(i.id));
    return (
      <Button variant="ghost" size="sm" disabled={rows.length === 0} onClick={() => setSelected(toggleAll(plan, selected, kind, !allOn))}>
        {allOn ? "Select none" : "Select all"}
      </Button>
    );
  };

  return (
    <Page>
      {header}
      <p className="text-sm">
        {selectionSummary(plan, selected)}
        {freed !== undefined && freed > 0 && <span className="text-muted-foreground"> · freed {formatMemory(freed)} last time</span>}
      </p>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {plan.items.length === 0 && !plan.dockerError && plan.projects.every((p) => !p.warning && !p.skipped) ? (
        <Empty title="Nothing to clean up." />
      ) : (
        <>
          <Section title="Branches & worktrees" hint="merged into their base, or deleted on the remote" action={selectAll("branch")}>
            {groups.map(({ project, items }) => (
              <div key={project.id}>
                <div className="flex items-center gap-2 bg-muted/40 px-4 py-1.5 text-sm font-medium">
                  {project.name}
                  {project.skipped && (
                    <>
                      <span className={muted}>not running, so its branches weren't scanned</span>
                      <Button size="sm" variant="outline" className="ml-auto h-7" onClick={() => void postAction(project.id, "start").catch(report)}>
                        Start
                      </Button>
                    </>
                  )}
                </div>
                {project.warning && <Note warn className="mx-4 my-2">{project.warning}</Note>}
                {items.length === 0 && !project.skipped && <p className={cn(muted, "px-4 py-2")}>Nothing to clean up.</p>}
                {items.map((item) => (
                  <Row key={item.id} item={item} selected={selected.has(item.id)} onToggle={(on) => toggle(item.id, on)} result={results.get(item.id)}>
                    <span className="font-mono text-sm">{item.branch}</span>
                    <Chip variant={item.why === "merged" ? "secondary" : "outline"}>{item.reason}</Chip>
                    {item.worktree && <Chip variant="outline">worktree</Chip>}
                    {item.env && <Chip variant="outline">own container</Chip>}
                    {item.dirty && <Chip className="border-attention/50 text-attention" variant="outline">uncommitted changes</Chip>}
                  </Row>
                ))}
              </div>
            ))}
          </Section>

          {plan.dockerError ? (
            <Note warn>Docker could not be listed, so containers and images weren't scanned: {plan.dockerError}</Note>
          ) : (
            <>
              <Section title="Containers" hint="no longer tied to a project or worktree" action={selectAll("container")}>
                {containers.length === 0 && <p className={cn(muted, "px-4 py-2")}>Nothing to clean up.</p>}
                {containers.map((item) => (
                  <Row key={item.id} item={item} selected={selected.has(item.id)} onToggle={(on) => toggle(item.id, on)} result={results.get(item.id)}>
                    <span className="font-mono text-sm">{item.name ?? item.containerId.slice(0, 12)}</span>
                    <span className={muted}>{item.reason}</span>
                    {item.running && <Chip className="border-attention/50 text-attention" variant="outline">running</Chip>}
                  </Row>
                ))}
              </Section>
              <Section title="Images" hint="opendevhub images nothing uses" action={selectAll("image")}>
                {images.length === 0 && <p className={cn(muted, "px-4 py-2")}>Nothing to clean up.</p>}
                {images.map((item) => (
                  <Row key={item.id} item={item} selected={selected.has(item.id)} onToggle={(on) => toggle(item.id, on)} result={results.get(item.id)}>
                    <span className="truncate font-mono text-sm">{item.ref}</span>
                    <span className={muted}>{item.reason}</span>
                    <span className="ml-auto text-sm tabular-nums text-muted-foreground">{formatMemory(item.bytes)}</span>
                  </Row>
                ))}
              </Section>
            </>
          )}
        </>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clean up {selectionSummary(plan, selected)}?</DialogTitle>
            <DialogDescription>Branches are deleted locally only. This can't be undone.</DialogDescription>
          </DialogHeader>
          {notes.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-sm text-attention">
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button variant={notes.length > 0 ? "destructive" : "default"} onClick={() => void apply()}>
              Clean up
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Page>
  );
}
