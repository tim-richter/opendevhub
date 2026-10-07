import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ForgejoCheck, ForgejoComment, ForgejoPullDetails, ForgejoReview } from "../../shared/forgejo";
import { fetchForgejoChecks, fetchForgejoComments, fetchForgejoReviewComments, fetchForgejoReviews } from "../api";
import { useForgejoPages, useForgejoQuery } from "../hooks/useForgejo";
import { Chip, Note, Section } from "./Page";

export interface ForgejoFeedback { comments: ForgejoComment[]; reviews: ForgejoReview[]; checks: ForgejoCheck[] }
export function RequestState({ query }: { query: { isPending: boolean; error: Error | null; refetch: () => unknown } }) {
  return <>{query.isPending && <p role="status" className="p-4 text-sm text-muted-foreground">Loading…</p>}
    {query.error && <div role="alert" className="p-4"><Note warn>{query.error.message}</Note><Button variant="link" onClick={() => void query.refetch()}>Retry</Button></div>}</>;
}
function More({ query }: { query: { hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage: () => unknown } }) {
  return query.hasNextPage && <Button className="m-4" variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load more"}</Button>;
}
function SelectFeedback({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return <label className="inline-flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />{label}</label>;
}
export function ForgejoContext({ details, onSelection }: { details: ForgejoPullDetails; onSelection: (feedback: ForgejoFeedback) => void }) {
  const { owner, repo, number } = details.pull;
  const args = [owner, repo, String(number)] as const;
  const key = ["pull", ...args];
  const comments = useForgejoPages([...key, "comments"], (page, signal) => fetchForgejoComments(...args, page, signal));
  const reviews = useForgejoPages([...key, "reviews"], (page, signal) => fetchForgejoReviews(...args, page, signal));
  const checks = useForgejoPages(["checks", owner, repo, details.headSha], (page, signal) => fetchForgejoChecks(owner, repo, details.headSha, page, signal), !!details.headSha);
  const [selected, setSelected] = useState<Record<string, { kind: keyof ForgejoFeedback; value: ForgejoComment | ForgejoReview | ForgejoCheck }>>({});
  const pick = (kind: keyof ForgejoFeedback, value: ForgejoComment | ForgejoReview | ForgejoCheck, checked: boolean) => {
    const next = { ...selected }; const id = `${kind}-${value.id}`;
    if (checked) next[id] = { kind, value }; else delete next[id];
    setSelected(next);
    onSelection({ comments: Object.values(next).filter((v) => v.kind === "comments").map((v) => v.value as ForgejoComment),
      reviews: Object.values(next).filter((v) => v.kind === "reviews").map((v) => v.value as ForgejoReview),
      checks: Object.values(next).filter((v) => v.kind === "checks").map((v) => v.value as ForgejoCheck) });
  };
  const commentCard = (c: ForgejoComment) => <article key={c.id} className="flex flex-col gap-2 border-b p-4 last:border-0">
    <div className="flex flex-wrap items-center gap-2 text-sm"><strong>{c.author}</strong><span className="text-muted-foreground">{c.updatedAt && new Date(c.updatedAt).toLocaleString()}</span>{c.resolved && <Chip>Resolved</Chip>}</div>
    {c.path && <p className="break-all font-mono text-xs">{c.path}:{c.line || c.oldLine || "?"}</p>}
    <p className="text-sm whitespace-pre-wrap break-words">{c.body}</p>
    {c.diffHunk && <details><summary className="cursor-pointer text-xs text-muted-foreground">Diff context</summary><pre className="overflow-x-auto p-2 text-xs">{c.diffHunk}</pre></details>}
    <SelectFeedback label="Include in agent handoff" checked={!!selected[`comments-${c.id}`]} onChange={(checked) => pick("comments", c, checked)} />
  </article>;
  const allComments = unique(comments.data?.pages.flatMap((p) => p.items) ?? []);
  const allReviews = unique(reviews.data?.pages.flatMap((p) => p.items) ?? []);
  const allChecks = unique(checks.data?.pages.flatMap((p) => p.items) ?? []);
  return <div className="grid items-start gap-4 lg:grid-cols-2">
    <Section title="Checks" hint={details.headSha.slice(0, 10)}>
      {!details.headSha ? <Note>PR head commit unavailable; open Forgejo to inspect checks.</Note> : <RequestState query={checks} />}
      {checks.data && !allChecks.length && <p className="p-4 text-sm text-muted-foreground">No checks reported for this commit.</p>}
      {allChecks.map((c) => <article key={c.id} className="flex flex-col gap-2 border-b p-4 last:border-0">
        <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{c.name}</strong><Chip className={c.status === "success" ? "text-ok" : ["failure", "error"].includes(c.status) ? "text-destructive" : ""}>{c.status}</Chip>
          {c.url && <a className="text-sm underline" href={c.url} target="_blank" rel="noreferrer">Details</a>}</div>
        <p className="text-sm whitespace-pre-wrap break-words">{c.description}</p>
        <SelectFeedback label="Include in agent handoff" checked={!!selected[`checks-${c.id}`]} onChange={(checked) => pick("checks", c, checked)} />
      </article>)}<More query={checks} />
    </Section>
    <Section title="Reviews" hint={details.reviewers.length ? `Requested: ${details.reviewers.join(", ")}` : undefined}>
      <RequestState query={reviews} />
      {reviews.data && !allReviews.length && <p className="p-4 text-sm text-muted-foreground">No reviews yet.</p>}
      {allReviews.map((r) => <article key={r.id} className="flex flex-col gap-2 border-b p-4 last:border-0">
        <div className="flex flex-wrap items-center gap-2 text-sm"><strong>{r.author}</strong><Chip>{r.state.replaceAll("_", " ")}</Chip>{r.dismissed && <Chip>Dismissed</Chip>}{r.stale && <Chip>Stale</Chip>}</div>
        <p className="text-xs text-muted-foreground">{r.submittedAt && new Date(r.submittedAt).toLocaleString()} · {r.commit?.slice(0, 10)}</p>
        <p className="text-sm whitespace-pre-wrap break-words">{r.body}</p>
        <SelectFeedback label="Include review in agent handoff" checked={!!selected[`reviews-${r.id}`]} onChange={(checked) => pick("reviews", r, checked)} />
        {!!r.commentsCount && <ReviewComments args={args} review={r.id} render={commentCard} />}
      </article>)}<More query={reviews} />
    </Section>
    <Section title="Discussion" className="lg:col-span-2">
      <RequestState query={comments} />
      {comments.data && !allComments.length && <p className="p-4 text-sm text-muted-foreground">No comments yet.</p>}
      {allComments.map(commentCard)}<More query={comments} />
    </Section>
  </div>;
}
function ReviewComments({ args, review, render }: { args: readonly [string, string, string]; review: number; render: (c: ForgejoComment) => ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const query = useForgejoQuery(["pull", ...args, "review-comments", review], (signal) => fetchForgejoReviewComments(...args, review, signal), expanded);
  return <div><Button variant="link" className="px-0" onClick={() => setExpanded((v) => !v)}>{expanded ? "Hide inline comments" : "Show inline comments"}</Button>
    {expanded && <><RequestState query={query} />{query.data?.map(render)}</>}</div>;
}
function unique<T extends { id: number }>(items: T[]): T[] { return [...new Map(items.map((i) => [i.id, i])).values()]; }
