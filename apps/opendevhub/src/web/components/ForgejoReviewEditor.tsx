import { Component, type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import { anchorFromRange } from "../review";
import { checkoutPath } from "../checkouts";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import type { ForgejoReviewInput, ForgejoReviewComment, ForgejoDiff } from "../../shared/forgejo";
import { createForgejoWorktree, sendForgejoReview } from "../api";
import { PatchView } from "./LazyPatchView";
import { Note, Section } from "./Page";
import { useDash } from "../DashboardContext";
import { forgejoFilePatches } from "../forgejo";

class DiffBoundary extends Component<{ patch: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <pre className="overflow-x-auto text-xs">{this.props.patch}</pre> : this.props.children; }
}

export function ForgejoReviewEditor({ data, split }: { data: ForgejoDiff; split: boolean }) {
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
    {forgejoFilePatches(data.patch).map((f) => ({ path: f.name, patch: f.patch })).map((file, index) => <div key={index}>
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
