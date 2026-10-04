import { Fragment } from "react";
import { Link } from "react-router";
import type { SessionSummary } from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import { useNow } from "../DashboardContext";
import { relativeTime, type SessionEntry, worktreeLabel } from "../derive";
import { Icon } from "./Icon";
import { PendingStack } from "./PendingCards";
import { targetOf } from "../review";
import { SessionBadge } from "./Status";
import { taskChip } from "../tasks";

export function SessionRow(props: {
  session: SessionSummary;
  openUrl: string;
  project?: { id: string; name: string };
  /** Set when the session works in a worktree rather than the main checkout. */
  worktree?: string;
  highlighted?: boolean;
  /** Link to this session's checkout in the Review tab. */
  reviewTo?: string;
  task?: { label: string; title: string; to?: string; model?: string };
  now: number;
}) {
  const { session, openUrl, project, worktree, highlighted, now } = props;
  return (
    <li className={`row session status-row-${session.status}${highlighted ? " highlight" : ""}`} id={`session-${session.id}`}>
      <SessionBadge status={session.status} />
      <span className="session-title" title={worktree ? `${session.title} — worktree ${worktree}` : session.title}>
        {props.task &&
          (props.task.to ? (
            <Link className="chip chip-task" to={props.task.to} title={props.task.title}>
              {props.task.label}
            </Link>
          ) : (
            <span className="chip chip-task" title={props.task.title}>
              {props.task.label}
            </span>
          ))}
        {props.task?.model && <span className="chip">{props.task.model}</span>}
        {worktree && (
          <span className="chip">
            <Icon name="branch" size={11} /> {worktree}
          </span>
        )}
        {session.title || "Untitled session"}
      </span>
      {project && (
        <Link className="session-project" to={`/p/${encodeURIComponent(project.id)}`}>
          {project.name}
        </Link>
      )}
      <time className="muted nowrap" dateTime={new Date(session.updatedAt).toISOString()} title={new Date(session.updatedAt).toLocaleString()}>
        {relativeTime(session.updatedAt, now)}
      </time>
      <span className="row-links">
        {props.reviewTo && (
          <Link className="row-review" to={props.reviewTo} title="Review this checkout's changes">
            Review
          </Link>
        )}
        <a className="row-action" href={sessionUrl(openUrl, session.id)} target="_blank" rel="noreferrer">
          {(session.status === "needs-permission" || session.status === "needs-answer") && !session.pending ? "Respond" : "Open"}{" "}
          <Icon name="external" size={13} />
        </a>
      </span>
    </li>
  );
}

export function SessionList(props: { entries: SessionEntry[]; showProject?: boolean; highlight?: string }) {
  const now = useNow();
  return (
    <ul className={`rows sessions${props.showProject ? " with-project" : ""}`}>
      {props.entries.map(({ session, view }) => (
        <Fragment key={session.id}>
          <SessionRow
            session={session}
            openUrl={view.openUrl}
            project={props.showProject ? { id: view.project.id, name: view.project.name } : undefined}
            worktree={worktreeLabel(view, session.directory)}
            highlighted={session.id === props.highlight}
            reviewTo={(() => {
              const t = targetOf(view, session.directory);
              return t === undefined ? undefined : `/p/${encodeURIComponent(view.project.id)}/review${t ? `/${encodeURIComponent(t)}` : ""}`;
            })()}
            task={taskChip(view, session)}
            now={now}
          />
          {session.pending && (
            <li className="pending-item" id={`pending-${session.id}`}>
              <PendingStack session={session} view={view} />
            </li>
          )}
        </Fragment>
      ))}
    </ul>
  );
}
