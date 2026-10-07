import { ArrowLeftIcon, ExternalLinkIcon, GitMergeIcon, GitPullRequestClosedIcon, GitPullRequestIcon, RefreshCwIcon } from "lucide-react";
import { Component, type ReactNode, useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { anchorFromRange } from "../review";
import { checkoutPath } from "../checkouts";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import type { ForgejoReviewInput, ForgejoReviewComment, ForgejoDiff, ForgejoPullFilter, ForgejoPulls } from "../../shared/forgejo";
import { createForgejoWorktree, sendForgejoReview, fetchForgejoDiff, fetchForgejoPulls } from "../api";
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
  const tab = search.get("tab") === "review" ? "review" : "authored";
  const state: ForgejoPullFilter = tab === "review" ? "open" : requested === "all" || requested === "closed" ? requested : "open";
  const load = useCallback((signal: AbortSignal) => fetchForgejoPulls(state, signal, tab), [state, tab]);
  const { data, error, busy, refresh } = useForgejoResource<ForgejoPulls>(load);
  return (
    <Page>
      <PageHeader title="Forgejo" description={tab === "review" ? "Select an open pull request to review." : data ? `Pull requests authored by ${data.username}.` : "Your open pull requests across repositories."}
        actions={<Button variant="outline" size="sm" disabled={busy} onClick={refresh}><RefreshCwIcon className={busy ? "animate-spin" : ""} /> Refresh</Button>} />
      <ForgejoGate>
        <Segmented label="Forgejo tabs" value={tab} onChange={(value) => setSearch(value === "review" ? { tab: "review" } : {})}
          options={[{ id: "authored", label: "My pull requests" }, { id: "review", label: "Review" }]} />
        {tab === "authored" && <Segmented label="Pull request state" value={state} onChange={(value) => setSearch(value === "open" ? {} : { state: value })}
          options={[{ id: "all", label: "All" }, { id: "open", label: "Open" }, { id: "closed", label: "Closed / merged" }]} />}
        {busy && <p role="status" className="text-sm text-muted-foreground">Loading pull requests…</p>}
        {error && <div role="alert"><Note warn>{error}</Note></div>}
        {data?.pulls.length === 0 && <Empty title="No pull requests"><p className="text-sm text-muted-foreground">No pull requests match this filter in repositories accessible to this token.</p></Empty>}
        {!!data?.pulls.length && <Section title="Pull requests" hint={`${data.pulls.length}`}>
          <ul className="divide-y">
            {data.pulls.map((pull) => (
              <li key={`${pull.owner}/${pull.repo}/${pull.number}${tab === "review" ? "?tab=review" : ""}`}>
                <Link className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
                  to={`/forgejo/${encodeURIComponent(pull.owner)}/${encodeURIComponent(pull.repo)}/${pull.number}${tab === "review" ? "?tab=review" : ""}`}>
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
  const [search] = useSearchParams();
  const reviewing = search.get("tab") === "review";
  const [style, setStyle] = useState<"unified" | "split">("unified");
  return (
    <Page className="max-w-none">
      <Link to={reviewing ? "/forgejo?tab=review" : "/forgejo"} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-4" /> Pull requests</Link>
      <PageHeader title={data?.pull.title ?? `${owner}/${repo} #${number}`}
        description={data ? `${owner}/${repo} #${number} · ${data.head} → ${data.base}` : "Pull request diff"}
        actions={<>
          {data && <Button asChild variant="outline" size="sm"><a href={data.pull.url} target="_blank" rel="noreferrer"><ExternalLinkIcon /> Open in Forgejo</a></Button>}
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { if (!reviewing || confirm("Refresh the diff? Any draft review comments will be discarded.")) refresh(); }}><RefreshCwIcon className={busy ? "animate-spin" : ""} /> Refresh</Button>
        </>} />
      <ForgejoGate>
        {busy && <div role="status" aria-label="Loading pull request diff"><DiffLinesSkeleton /></div>}
        {error && <div role="alert"><Note warn>{error}</Note></div>}
        {data && <>
          <Segmented label="Diff layout" value={style} onChange={setStyle} options={[{ id: "unified", label: "Unified" }, { id: "split", label: "Side by side" }]} />
          {reviewing && data.pull.state === "open" ? <ReviewEditor key={data.commitId} data={data} split={style === "split"} /> : data.patch.trim() ? (
            <div className={`overflow-hidden rounded-xl border ${diffFont}`}>
              <DiffBoundary key={data.patch} patch={data.patch}><PatchView patch={data.patch} split={style === "split"} /></DiffBoundary>
            </div>
          ) : <Empty title="No changes in this pull request" />}
        </>}
      </ForgejoGate>
    </Page>
  );
}

function patchFiles(patch: string): { path: string; patch: string }[] {
  return patch.split(/(?=^diff --git )/m).filter((part) => part.startsWith("diff --git ")).map((part) => {
    const header = part.match(/^\+\+\+ (.+)$/m)?.[1] ?? part.match(/^--- (.+)$/m)?.[1] ?? "";
    let name = header;
    if (name === "/dev/null") name = part.match(/^--- (.+)$/m)?.[1] ?? "";
    if (name.startsWith('"')) { try { name = JSON.parse(name); } catch { name = ""; } }
    return { path: name.replace(/^[ab]\//, ""), patch: part };
  });
}

function ReviewEditor({ data, split }: { data: ForgejoDiff; split: boolean }) {
  const { snapshot } = useDash();
  const navigate = useNavigate();
  const [comments, setComments] = useState<ForgejoReviewComment[]>([]);
  const [anchor, setAnchor] = useState<{ path: string; line: number; side: "old" | "new" }>();
  const [text, setText] = useState("");
  const [body, setBody] = useState("");
  const [event, setEvent] = useState<ForgejoReviewInput["event"]>("COMMENT");
  const [project, setProject] = useState("");
  const [branch, setBranch] = useState(`review/pr-${data.pull.number}`);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setPending(true); setError(""); setSent(false);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };
  return <div className="flex flex-col gap-4 p-4">
    <p className="text-sm text-muted-foreground">Click the + beside a diff line to add a review comment.</p>
    {patchFiles(data.patch).map((file, index) => <div key={index}>
      <DiffBoundary patch={file.patch}><PatchView patch={file.patch} split={split} onComment={file.path ? (range) => {
        if (text && !confirm("Discard the unfinished comment?")) return;
        const a = anchorFromRange(file.patch, range);
        setAnchor({ path: file.path, line: a.line, side: a.side }); setText("");
      } : undefined} /></DiffBoundary>
    </div>)}
    {anchor && <div className="flex flex-col gap-2">
      <p>{anchor.path}:{anchor.line} ({anchor.side})</p>
      <Textarea aria-label="Inline review comment" value={text} onChange={(e) => setText(e.target.value)} disabled={pending} />
      <Button disabled={!text.trim() || pending} onClick={() => {
        setComments([...comments, { path: anchor.path, body: text, old_position: anchor.side === "old" ? anchor.line : 0, new_position: anchor.side === "new" ? anchor.line : 0 }]);
        setAnchor(undefined); setText(""); setSent(false);
      }}>Add comment</Button>
      <Button variant="ghost" disabled={pending} onClick={() => { setAnchor(undefined); setText(""); }}>Cancel comment</Button>
    </div>}
    {comments.map((comment, index) => <div key={index} className="rounded border p-3">
      <p className="text-sm text-muted-foreground">{comment.path}:{comment.new_position || comment.old_position}</p>
      <p className="whitespace-pre-wrap">{comment.body}</p>
      <Button variant="ghost" disabled={pending} onClick={() => setComments(comments.filter((_, i) => i !== index))}>Remove comment</Button>
    </div>)}
    <Textarea aria-label="Review summary" placeholder="Review summary" value={body} disabled={pending} onChange={(e) => { setBody(e.target.value); setSent(false); }} />
    <label>Review outcome <select aria-label="Review outcome" value={event} disabled={pending} onChange={(e) => setEvent(e.target.value as ForgejoReviewInput["event"])}>
      <option value="COMMENT">Comment</option><option value="APPROVED">Approve</option><option value="REQUEST_CHANGES">Request changes</option>
    </select></label>
    <Button disabled={pending || !!text.trim() || !data.commitId || (event === "COMMENT" && !body.trim() && !comments.length)} onClick={() => void run(async () => {
      await sendForgejoReview(data.pull.owner, data.pull.repo, String(data.pull.number), { commitId: data.commitId!, body, event, comments });
      setComments([]); setBody(""); setSent(true);
    })}>{pending ? "Working…" : `Send review to Forgejo (${comments.length} inline comments)`}</Button>
    {sent && <p role="status">Review sent to Forgejo.</p>}
    <Section title="Inspect in a container" hint="Select the local project for this repository. Its container must be running with worktrees mounted.">
      <div className="flex flex-col gap-3 p-4">
        <select aria-label="Local project" value={project} disabled={pending} onChange={(e) => setProject(e.target.value)}>
          <option value="">Select project</option>
          {snapshot?.projects.map((view) => <option key={view.project.id} value={view.project.id}>{view.project.name}</option>)}
        </select>
        <Input aria-label="Worktree branch" value={branch} disabled={pending} onChange={(e) => setBranch(e.target.value)} />
        <Button disabled={pending || !project || !branch.trim() || !data.commitId} onClick={() => void run(async () => {
          const result = await createForgejoWorktree(data.pull.owner, data.pull.repo, String(data.pull.number), project, branch, data.commitId!);
          const folder = result.worktree.path.split("/").filter(Boolean).at(-1)!;
          await navigate(checkoutPath(project, folder));
        })}>Create PR worktree</Button>
        <p className="text-sm text-muted-foreground">Open the worktree to inspect the code using the project container or start its own container.</p>
      </div>
    </Section>
    {error && <div role="alert"><Note warn>{error}</Note></div>}
  </div>;
}
