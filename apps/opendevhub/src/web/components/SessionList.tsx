import { Fragment } from "react";
import { Link } from "react-router";
import type { SessionSummary } from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import { useNow } from "../DashboardContext";
import { checkoutOf, checkoutPath } from "../checkouts";
import { openUrlOf, relativeTime, type SessionEntry, worktreeLabel } from "../derive";
import { ExternalLinkIcon, GitBranchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Chip } from "./Page";
import { PendingStack } from "./PendingCards";
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
  const waiting = session.status === "needs-permission" || session.status === "needs-answer";
  return (
    <li
      className={cn(
        "grid items-center gap-x-3.5 border-t px-4 py-2 first:border-t-0 hover:bg-muted/50",
        "max-md:grid-cols-[auto_minmax(0,1fr)_auto] max-md:gap-y-1",
        project ? "md:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,10rem)_6rem_9rem]" : "md:grid-cols-[8.5rem_minmax(0,1fr)_6rem_9rem]",
        highlighted && "bg-attention/10 shadow-[inset_3px_0_var(--attention)]",
      )}
      id={`session-${session.id}`}
    >
      <span className="justify-self-start">
        <SessionBadge status={session.status} />
      </span>
      <span className="truncate max-md:col-span-full max-md:row-start-1" title={worktree ? `${session.title} — worktree ${worktree}` : session.title}>
        {props.task &&
          (props.task.to ? (
            <Chip asChild className="mr-1.5 text-foreground hover:bg-accent hover:text-accent-foreground">
              <Link to={props.task.to} title={props.task.title}>
                {props.task.label}
              </Link>
            </Chip>
          ) : (
            <Chip className="mr-1.5 text-foreground" title={props.task.title}>
              {props.task.label}
            </Chip>
          ))}
        {props.task?.model && <Chip className="mr-1.5">{props.task.model}</Chip>}
        {worktree && (
          <Chip className="mr-1.5">
            <GitBranchIcon /> {worktree}
          </Chip>
        )}
        {session.title || "Untitled session"}
      </span>
      {project && (
        <Link className="truncate text-sm text-muted-foreground hover:text-foreground max-md:col-span-2" to={`/p/${encodeURIComponent(project.id)}`}>
          {project.name}
        </Link>
      )}
      <time
        className="text-right text-xs whitespace-nowrap text-muted-foreground max-md:hidden"
        dateTime={new Date(session.updatedAt).toISOString()}
        title={new Date(session.updatedAt).toLocaleString()}
      >
        {relativeTime(session.updatedAt, now)}
      </time>
      <span className="inline-flex items-center gap-2.5 justify-self-end">
        {props.reviewTo && (
          <Link className="text-sm text-muted-foreground hover:text-foreground" to={props.reviewTo} title="Review this checkout's changes">
            Review
          </Link>
        )}
        <a
          className={cn("inline-flex items-center gap-1 text-sm font-medium whitespace-nowrap hover:underline", waiting && "text-attention")}
          href={sessionUrl(openUrl, session.id)}
          target="_blank"
          rel="noreferrer"
        >
          {waiting && !session.pending ? "Respond" : "Open"} <ExternalLinkIcon className="size-3.5" />
        </a>
      </span>
    </li>
  );
}

export function SessionList(props: {
  entries: SessionEntry[];
  showProject?: boolean;
  highlight?: string;
  /** Inside a checkout's own page, where the worktree chip says nothing new. */
  hideWorktree?: boolean;
}) {
  const now = useNow();
  return (
    <ul>
      {props.entries.map(({ session, view }) => (
        <Fragment key={session.id}>
          <SessionRow
            session={session}
            openUrl={openUrlOf(view, session.envId)}
            project={props.showProject ? { id: view.project.id, name: view.project.name } : undefined}
            worktree={props.hideWorktree ? undefined : worktreeLabel(view, session.directory)}
            highlighted={session.id === props.highlight}
            reviewTo={(() => {
              const c = checkoutOf(view, session.directory);
              return c && checkoutPath(view.project.id, c.target, "review");
            })()}
            task={taskChip(view, session)}
            now={now}
          />
          {session.pending && (
            <li className="px-4 pb-3" id={`pending-${session.id}`}>
              <PendingStack session={session} view={view} />
            </li>
          )}
        </Fragment>
      ))}
    </ul>
  );
}
