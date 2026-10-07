import { ArrowLeftIcon, ExternalLinkIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import { Component, type ReactNode, useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import type { ForgejoDiff, ForgejoPullFilter, ForgejoPulls } from "../../shared/forgejo";
import { fetchForgejoDiff, fetchForgejoPulls } from "../api";
import { PatchView } from "../components/LazyPatchView";
import { Chip, diffFont, Empty, Note, Page, PageHeader, Section, Segmented } from "../components/Page";
import { DiffLinesSkeleton } from "../components/Skeletons";
import { useDash } from "../DashboardContext";

function useForgejoResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const { forgejo } = useDash();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setData(undefined);
    setError(undefined);
    if (!forgejo?.enabled) { setBusy(false); return; }
    const controller = new AbortController();
    setBusy(true);
    void load(controller.signal).then(
      (value) => { if (!controller.signal.aborted) setData(value); },
      (err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); },
    ).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [forgejo, load, revision]);
  return { data, error, busy, refresh: () => setRevision((value) => value + 1) };
}

function ForgejoGate({ children }: { children: ReactNode }) {
  const { forgejo, forgejoError } = useDash();
  if (!forgejo && !forgejoError) return <p role="status" className="text-sm text-muted-foreground">Loading Forgejo settings…</p>;
  if (!forgejo?.enabled) return (
    <Empty title="Forgejo is disabled">
      {forgejoError && <Note warn>{forgejoError}</Note>}
      <p className="text-sm text-muted-foreground">Connect your Forgejo account to see your pull requests.</p>
      <Button asChild variant="outline"><Link to="/settings">Open settings</Link></Button>
    </Empty>
  );
  return children;
}

export function ForgejoPage() {
  const [search, setSearch] = useSearchParams();
  const requested = search.get("state");
  const state: ForgejoPullFilter = requested === "open" || requested === "closed" ? requested : "all";
  const load = useCallback((signal: AbortSignal) => fetchForgejoPulls(state, signal), [state]);
  const { data, error, busy, refresh } = useForgejoResource<ForgejoPulls>(load);
  return (
    <Page>
      <PageHeader title="Forgejo" description={data ? `Pull requests authored by ${data.username}.` : "All your pull requests across repositories."}
        actions={<Button variant="outline" size="sm" disabled={busy} onClick={refresh}><RefreshCwIcon className={busy ? "animate-spin" : ""} /> Refresh</Button>} />
      <ForgejoGate>
        <Segmented label="Pull request state" value={state} onChange={(value) => setSearch(value === "all" ? {} : { state: value })}
          options={[{ id: "all", label: "All" }, { id: "open", label: "Open" }, { id: "closed", label: "Closed / merged" }]} />
        {busy && <p role="status" className="text-sm text-muted-foreground">Loading pull requests…</p>}
        {error && <div role="alert"><Note warn>{error}</Note></div>}
        {data?.pulls.length === 0 && <Empty title="No pull requests"><p className="text-sm text-muted-foreground">No pull requests match this filter in repositories accessible to this token.</p></Empty>}
        {!!data?.pulls.length && <Section title="Pull requests" hint={`${data.pulls.length}`}>
          <ul className="divide-y">
            {data.pulls.map((pull) => (
              <li key={`${pull.owner}/${pull.repo}/${pull.number}`}>
                <Link className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                  to={`/forgejo/${encodeURIComponent(pull.owner)}/${encodeURIComponent(pull.repo)}/${pull.number}`}>
                  {pull.state === "merged" ? <GitMergeIcon className="mt-0.5 size-4 shrink-0 text-violet-500" /> : pull.state === "closed" ? <GitPullRequestClosedIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <GitPullRequestIcon className="mt-0.5 size-4 shrink-0 text-ok" />}
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">{pull.title}</p>
                    <p className="text-sm text-muted-foreground">{pull.owner}/{pull.repo} #{pull.number}</p>
                  </div>
                  <Chip>{pull.state === "merged" ? "Merged" : pull.state === "closed" ? "Closed" : "Open"}</Chip>
                </Link>
              </li>
            ))}
          </ul>
        </Section>}
      </ForgejoGate>
    </Page>
  );
}

export function ForgejoPullPage() {
  const { owner = "", repo = "", number = "" } = useParams();
  // A new selection starts with a fresh loading state, never the previous PR's diff.
  return <PullDiff key={`${owner}/${repo}/${number}`} owner={owner} repo={repo} number={number} />;
}

class DiffBoundary extends Component<{ patch: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? (
      <div className="flex flex-col gap-3">
        <Note warn>The diff renderer could not display this patch. The raw diff is shown below.</Note>
        <pre className="overflow-x-auto rounded-lg border p-4 font-mono text-xs">{this.props.patch}</pre>
      </div>
    ) : this.props.children;
  }
}

function PullDiff({ owner, repo, number }: { owner: string; repo: string; number: string }) {
  const load = useCallback((signal: AbortSignal) => fetchForgejoDiff(owner, repo, number, signal), [owner, repo, number]);
  const { data, error, busy, refresh } = useForgejoResource<ForgejoDiff>(load);
  const [style, setStyle] = useState<"unified" | "split">("unified");
  return (
    <Page className="max-w-none">
      <Link to="/forgejo" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-4" /> Pull requests</Link>
      <PageHeader title={data?.pull.title ?? `${owner}/${repo} #${number}`}
        description={data ? `${owner}/${repo} #${number} · ${data.head} → ${data.base}` : "Pull request diff"}
        actions={<>
          {data && <Button asChild variant="outline" size="sm"><a href={data.pull.url} target="_blank" rel="noreferrer"><ExternalLinkIcon /> Open in Forgejo</a></Button>}
          <Button variant="outline" size="sm" disabled={busy} onClick={refresh}><RefreshCwIcon className={busy ? "animate-spin" : ""} /> Refresh</Button>
        </>} />
      <ForgejoGate>
        {busy && <div role="status" aria-label="Loading pull request diff"><DiffLinesSkeleton /></div>}
        {error && <div role="alert"><Note warn>{error}</Note></div>}
        {data && <>
          <Segmented label="Diff layout" value={style} onChange={setStyle} options={[{ id: "unified", label: "Unified" }, { id: "split", label: "Side by side" }]} />
          {data.patch.trim() ? (
            <div className={`overflow-hidden rounded-xl border ${diffFont}`}>
              <DiffBoundary key={data.patch} patch={data.patch}><PatchView patch={data.patch} split={style === "split"} /></DiffBoundary>
            </div>
          ) : <Empty title="No changes in this pull request" />}
        </>}
      </ForgejoGate>
    </Page>
  );
}
