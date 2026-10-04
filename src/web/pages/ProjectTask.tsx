import { useEffect, useRef, useState } from "react";
import { Link, useOutletContext, useParams } from "react-router";
import type { ProjectView, ReviewData, SessionSummary } from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import { fetchReview, pickVariant } from "../api";
import { Icon } from "../components/Icon";
import { SessionBadge } from "../components/Status";
import { useDash } from "../DashboardContext";
import { targetOf } from "../review";
import { diffStats, formatCost, formatTokens, pickPrompts, removals, taskSessions, variantName } from "../tasks";

export function ProjectTask() {
  const view = useOutletContext<ProjectView>();
  const { task = "" } = useParams();
  const { report } = useDash();
  const sessions = taskSessions(view, task);
  const [reviews, setReviews] = useState<Record<string, ReviewData>>({});
  const [picking, setPicking] = useState(false);
  const [notice, setNotice] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const projectPath = `/p/${encodeURIComponent(view.project.id)}`;

  // Reload a variant's changes when its session changes state (e.g. it finished a turn).
  const reloadKey = sessions.map((s) => `${s.id}:${s.status}:${s.directory}`).join("|");
  useEffect(() => {
    let live = true;
    for (const s of sessions) {
      fetchReview(view.project.id, s.directory).then(
        (r) => live && setReviews((all) => ({ ...all, [s.directory]: r })),
        () => {},
      );
    }
    return () => {
      live = false;
    };
    // `sessions` is rebuilt on every snapshot; reloadKey holds what matters.
  }, [view.project.id, reloadKey]);

  const pick = async (keep: SessionSummary) => {
    if (picking) return;
    const others = sessions.filter((s) => s.id !== keep.id);
    const name = variantName(keep);
    if (!confirm(pickPrompts(name, others.length, []).discard)) return;
    setPicking(true);
    setNotice(undefined);
    try {
      // Re-read the others' changes: the cached ones may predate edits made while this page was open.
      const dirs = [...new Set(others.map((s) => s.directory))];
      const fresh = await Promise.allSettled(dirs.map((d) => fetchReview(view.project.id, d)));
      if (!mounted.current) return;
      const dirty: Record<string, boolean> = {};
      fresh.forEach((r, i) => {
        if (r.status === "fulfilled") dirty[dirs[i]] = r.value.dirty;
      });
      const prompts = pickPrompts(name, others.length, removals(view, task, keep.id, dirty));
      const removeWorktrees = prompts.remove ? confirm(prompts.remove) : false;
      const r = await pickVariant(view.project.id, task, keep.id, removeWorktrees);
      const removed = r.removed.length > 0 ? `, removed ${r.removed.length} worktree${r.removed.length === 1 ? "" : "s"}` : "";
      if (mounted.current) setNotice(`Kept ${name}. Discarded ${r.discarded.length}${removed}.`);
      if (r.errors.length > 0) report(new Error(r.errors.join("; ")));
    } catch (e) {
      report(e);
    } finally {
      if (mounted.current) setPicking(false);
    }
  };

  if (sessions.length === 0) {
    return (
      <div className="empty">
        <h2>No variants to show</h2>
        <p className="muted">This task's sessions were discarded, or are older than the sessions opencode lists.</p>
        <Link to={projectPath}>Back to sessions</Link>
      </div>
    );
  }

  return (
    <div className="tab-body">
      <div className="task-head">
        <h2>{sessions[0].task?.title || "Task"}</h2>
        <span className="muted">
          {sessions.length} variant{sessions.length === 1 ? "" : "s"}
        </span>
      </div>
      {notice && <div className="banner ok">{notice}</div>}
      <div className="task-columns">
        {sessions.map((s) => {
          const review = reviews[s.directory];
          const stats = review ? diffStats(review) : undefined;
          const target = targetOf(view, s.directory);
          return (
            <section key={s.id} className="task-column">
              <header>
                <SessionBadge status={s.status} />
                <strong>{variantName(s)}</strong>
              </header>
              <dl className="task-facts">
                <dt>Branch</dt>
                <dd className="mono">{review?.branch ?? "—"}</dd>
                <dt>Cost</dt>
                <dd>{formatCost(s.cost)}</dd>
                <dt>Tokens</dt>
                <dd>{formatTokens(s.tokens)}</dd>
                <dt>Changes</dt>
                <dd>
                  {stats ? (
                    <>
                      {stats.files} file{stats.files === 1 ? "" : "s"} <span className="add">+{stats.additions}</span>{" "}
                      <span className="del">−{stats.deletions}</span>
                      {review?.dirty ? <span className="muted"> · uncommitted</span> : null}
                    </>
                  ) : (
                    "—"
                  )}
                </dd>
              </dl>
              <div className="task-links">
                {target !== undefined && (
                  <Link className="button small" to={`${projectPath}/review${target ? `/${encodeURIComponent(target)}` : ""}`}>
                    Review
                  </Link>
                )}
                <a className="button small" href={sessionUrl(view.openUrl, s.id)} target="_blank" rel="noreferrer">
                  Open <Icon name="external" size={12} />
                </a>
                {sessions.length > 1 && (
                  <button className="small" disabled={picking} onClick={() => pick(s)}>
                    Pick this one
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
