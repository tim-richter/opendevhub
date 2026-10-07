import { ArrowLeftIcon, ExternalLinkIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Component, type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ForgejoInbox, ForgejoPullFilter } from "../../shared/forgejo";
import { fetchForgejoDetails, fetchForgejoDiff, fetchForgejoPulls } from "../api";
import { PatchView } from "../components/LazyPatchView";
import { Chip, diffFont, Empty, Note, Page, PageHeader, Section, Segmented } from "../components/Page";
import { DiffLinesSkeleton } from "../components/Skeletons";
import { useDash } from "../DashboardContext";
import { useForgejoQuery } from "../hooks/useForgejo";
import { forgejoFilePatches, readForgejoPreference, saveForgejoPreference } from "../forgejo";
import { ForgejoContext, RequestState, type ForgejoFeedback } from "../components/ForgejoContext";
import { ForgejoReviewEditor } from "../components/ForgejoReviewEditor";
import { ForgejoHandoff } from "../components/ForgejoHandoff";

function ForgejoGate({ children }: { children: ReactNode }) {
  const { forgejo, forgejoError } = useDash();
  if (!forgejo && !forgejoError) return <p role="status" className="text-sm text-muted-foreground">Loading Forgejo settings…</p>;
  if (!forgejo?.enabled) return <Empty title="Forgejo is disabled">{forgejoError && <Note warn>{forgejoError}</Note>}
    <p className="text-sm text-muted-foreground">Connect your Forgejo account to see your pull requests.</p>
    <Button asChild variant="outline"><Link to="/settings">Open settings</Link></Button></Empty>;
  return children;
}
function Refresh({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return <Button variant="outline" size="sm" disabled={busy} onClick={onClick}><RefreshCwIcon className={busy ? "animate-spin" : ""} /> Refresh</Button>;
}
export function ForgejoPage() {
  const { forgejo } = useDash();
  const [search, setSearch] = useSearchParams();
  // Explicit URL filters win; a bare sidebar link restores the last view.
  const filters = search.size ? search : new URLSearchParams(readForgejoPreference("inbox"));
  const state: ForgejoPullFilter = filters.get("state") === "all" || filters.get("state") === "closed" ? filters.get("state") as ForgejoPullFilter : "open";
  const inbox: ForgejoInbox = ["assigned", "review-requested", "review"].includes(filters.get("inbox") ?? "") ? filters.get("inbox") as ForgejoInbox : filters.get("tab") === "review" ? "review" : "authored";
  const q = filters.get("q") ?? "";
  const repository = filters.get("repository") ?? "";
  const [queryInput, setQueryInput] = useState(q);
  const [repoInput, setRepoInput] = useState(repository);
  const change = (key: string, value: string) => { const next = new URLSearchParams(filters); next.set(key, value); setSearch(next, { replace: true }); };
  useEffect(() => { setQueryInput(q); setRepoInput(repository); }, [q, repository]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (queryInput === q && repoInput === repository) return;
      const next = new URLSearchParams(filters); next.set("q", queryInput.trim()); next.set("repository", repoInput.trim()); setSearch(next, { replace: true });
    }, 400);
    return () => clearTimeout(timer);
  }, [queryInput, repoInput, q, repository, filters.toString(), setSearch]);
  const listSearch = new URLSearchParams({ state, inbox, ...(q ? { q } : {}), ...(repository ? { repository } : {}) }).toString();
  useEffect(() => { saveForgejoPreference("inbox", listSearch); }, [listSearch]);
  const query = useInfiniteQuery({ queryKey: ["forgejo", forgejo?.url, "inbox", { state, inbox, q, repository }],
    queryFn: ({ pageParam, signal }) => fetchForgejoPulls({ state, inbox, q, repository, page: pageParam }, signal),
    initialPageParam: 1, getNextPageParam: (last) => last.nextPage, enabled: !!forgejo?.enabled });
  const pulls = [...new Map((query.data?.pages.flatMap((p) => p.pulls) ?? []).map((p) => [`${p.owner}/${p.repo}/${p.number}`, p])).values()];
  const username = query.data?.pages[0]?.username;
  return <Page>
    <PageHeader title="Forgejo" description={username ? `Pull requests for ${username}.` : "Your pull requests and review inbox."}
      actions={<Refresh busy={query.isFetching} onClick={() => void query.refetch()} />} />
    <ForgejoGate>
      <Segmented label="Pull request inbox" value={inbox} onChange={(value) => change("inbox", value)} options={[{ id: "authored", label: "Authored by me" }, { id: "review-requested", label: "Review requested" }, { id: "assigned", label: "Assigned to me" }, { id: "review", label: "Review all" }]} />
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Pull request state" value={state} onChange={(value) => change("state", value)} options={[{ id: "all", label: "All" }, { id: "open", label: "Open" }, { id: "closed", label: "Closed / merged" }]} />
        <Input className="w-full sm:w-64" aria-label="Search pull requests" placeholder="Search pull requests…" value={queryInput} maxLength={200} onChange={(e) => setQueryInput(e.target.value)} />
        <Input className="w-full sm:w-56" aria-label="Repository filter" placeholder="Repository: owner/name" value={repoInput} onChange={(e) => setRepoInput(e.target.value)} />
      </div>
      <RequestState query={query} />
      {query.data && !pulls.length && <Empty title={query.hasNextPage ? "No matches in the loaded pages" : "No pull requests"}><p className="text-sm text-muted-foreground">{query.hasNextPage ? "Load more to search the remaining pages." : "No pull requests match this view in repositories accessible to the token."}</p></Empty>}
      {!!pulls.length && <Section title="Pull requests" hint={`${pulls.length} loaded`}><ul className="divide-y">
        {pulls.map((pull) => <li key={`${pull.owner}/${pull.repo}/${pull.number}`}>
          <Link className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring" to={`/forgejo/${encodeURIComponent(pull.owner)}/${encodeURIComponent(pull.repo)}/${pull.number}?${listSearch}`}>
            {pull.state === "merged" ? <GitMergeIcon className="mt-0.5 size-4 shrink-0 text-violet-500" /> : pull.state === "closed" ? <GitPullRequestClosedIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : <GitPullRequestIcon className="mt-0.5 size-4 shrink-0 text-ok" />}
            <div className="min-w-0 flex-1"><p className="font-medium break-words">{pull.title}</p><p className="text-sm text-muted-foreground">{pull.owner}/{pull.repo} #{pull.number} · Updated {new Date(pull.updatedAt).toLocaleString()}</p></div>
            <Chip>{pull.state}</Chip>
          </Link>
        </li>)}
      </ul></Section>}
      {query.hasNextPage && <Button className="self-start" variant="outline" disabled={query.isFetching} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load more pull requests"}</Button>}
      {query.dataUpdatedAt > 0 && <p className="text-xs text-muted-foreground">Last refreshed {new Date(query.dataUpdatedAt).toLocaleTimeString()}{query.isFetching && " · Refreshing…"}</p>}
    </ForgejoGate>
  </Page>;
}
export function ForgejoPullPage() {
  const { owner = "", repo = "", number = "" } = useParams();
  return <PullDiff key={`${owner}/${repo}/${number}`} owner={owner} repo={repo} number={number} />;
}
class DiffBoundary extends Component<{ patch: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div><Note warn>The renderer could not display this patch. Raw diff:</Note><pre className="overflow-x-auto rounded-lg border p-4 font-mono text-xs">{this.props.patch}</pre></div> : this.props.children; }
}
function PullDiff({ owner, repo, number }: { owner: string; repo: string; number: string }) {
  const { forgejo } = useDash();
  const [search] = useSearchParams();
  const client = useQueryClient();
  const [reviewing, setReviewing] = useState(search.get("tab") === "review" || search.get("inbox") === "review");
  const key = ["pull", owner, repo, number];
  const details = useForgejoQuery([...key, "details"], (signal) => fetchForgejoDetails(owner, repo, number, signal), true, { refetchOnWindowFocus: !reviewing, refetchOnReconnect: !reviewing });
  const patch = useForgejoQuery([...key, "patch", details.data?.headSha, details.data?.base, details.data?.pull.updatedAt], (signal) => fetchForgejoDiff(owner, repo, number, signal), !!details.data, { refetchOnWindowFocus: !reviewing, refetchOnReconnect: !reviewing });
  const [style, setStyle] = useState<"unified" | "split">(() => readForgejoPreference("layout") === "split" ? "split" : "unified");
  const [selectedFile, setSelectedFile] = useState<number | null>(null);
  const [feedback, setFeedback] = useState<ForgejoFeedback>({ comments: [], reviews: [], checks: [] });
  const [handoff, setHandoff] = useState(false);
  useEffect(() => { setSelectedFile(null); setFeedback({ comments: [], reviews: [], checks: [] }); }, [details.data?.headSha]);
  const files = useMemo(() => forgejoFilePatches(patch.data?.patch ?? ""), [patch.data?.patch]);
  const shownPatch = selectedFile !== null && files[selectedFile] ? files[selectedFile].patch : patch.data?.patch ?? "";
  const url = forgejo?.url ? `${forgejo.url}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(number)}` : undefined;
  const refresh = async () => {
    // Keep old content visible while fetching. Commit-specific patch/check keys prevent mixing revisions.
    if (reviewing && !confirm("Refresh the diff? Draft review comments will be discarded.")) return;
    setReviewing(false);
    await details.refetch();
    await client.invalidateQueries({ queryKey: ["forgejo", forgejo?.url, ...key], predicate: (query) => query.queryKey[6] !== "details" });
    await client.invalidateQueries({ queryKey: ["forgejo", forgejo?.url, "checks", owner, repo] });
  };
  return <Page className="max-w-none">
    <Link to={`/forgejo?${search.size ? search.toString() : readForgejoPreference("inbox")}`} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-4" /> Pull requests</Link>
    <PageHeader title={details.data?.pull.title ?? `${owner}/${repo} #${number}`} description={details.data ? `${owner}/${repo} #${number} · ${details.data.head} → ${details.data.base}` : "Pull request"} actions={<>
      {url && <Button asChild variant="outline" size="sm"><a href={url} target="_blank" rel="noreferrer"><ExternalLinkIcon /> Open in Forgejo</a></Button>}
      {details.data?.pull.state === "open" && <Button variant="outline" size="sm" onClick={() => setReviewing((v) => !v)}>{reviewing ? "Close review editor" : "Write review"}</Button>}
      {details.data && <Button size="sm" onClick={() => setHandoff(true)}>Continue with agent</Button>}
      <Refresh busy={details.isFetching || patch.isFetching} onClick={() => void refresh()} />
    </>} />
    <ForgejoGate>
      <RequestState query={details} />
      {details.data && <>
        <div className="flex flex-wrap items-center gap-2"><Chip>{details.data.pull.state}</Chip>{details.data.draft && <Chip>Draft</Chip>}{details.data.mergeable === false && details.data.pull.state === "open" && <Chip>Merge conflicts</Chip>}<span className="text-sm text-muted-foreground">By {details.data.author}</span>{details.data.labels.map((l) => <Chip key={l}>{l}</Chip>)}</div>
        <Section title="Description"><p className="p-4 text-sm whitespace-pre-wrap break-words">{details.data.body || "No description."}</p></Section>
        <ForgejoContext key={details.data.headSha} details={details.data} onSelection={setFeedback} />
        {handoff && <ForgejoHandoff details={details.data} feedback={feedback} onClose={() => setHandoff(false)} />}
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="font-semibold">Changes</h2><Segmented label="Diff layout" value={style} onChange={(value) => { setStyle(value); saveForgejoPreference("layout", value); }} options={[{ id: "unified", label: "Unified" }, { id: "split", label: "Side by side" }]} /></div>
        {patch.isPending && <div role="status" aria-label="Loading pull request diff"><DiffLinesSkeleton /></div>}
        {patch.error && <div role="alert"><Note warn>{patch.error.message}</Note><Button variant="link" onClick={() => void patch.refetch()}>Retry diff</Button></div>}
        {patch.data && reviewing && details.data.pull.state === "open" ? <ForgejoReviewEditor key={details.data.headSha} data={{ pull: details.data.pull, base: details.data.base, head: details.data.head, commitId: details.data.headSha, patch: patch.data.patch }} split={style === "split"} /> : patch.data && (patch.data.patch.trim() ? <div className="grid items-start gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <nav aria-label="Changed files" className="flex flex-col gap-1 rounded-lg border p-2 lg:sticky lg:top-4 lg:max-h-[70vh] lg:overflow-y-auto">
            <button className="rounded px-2 py-1.5 text-left text-sm hover:bg-muted" aria-current={selectedFile === null ? "true" : undefined} onClick={() => setSelectedFile(null)}>All changed files ({files.length})</button>
            {files.map((f, i) => <button key={i} className={`rounded px-2 py-1.5 text-left text-xs break-all hover:bg-muted ${selectedFile === i ? "bg-muted" : ""}`} aria-current={selectedFile === i ? "true" : undefined} onClick={() => setSelectedFile(i)}>{f.name} <span className="whitespace-nowrap"><span className="text-ok">+{f.additions}</span> <span className="text-destructive">−{f.deletions}</span></span></button>)}
          </nav><div className={`min-w-0 overflow-hidden rounded-xl border ${diffFont}`}><DiffBoundary key={shownPatch} patch={shownPatch}><PatchView patch={shownPatch} split={style === "split"} /></DiffBoundary></div>
        </div> : <Empty title="No changes in this pull request" />)}
      </>}
    </ForgejoGate>
  </Page>;
}
