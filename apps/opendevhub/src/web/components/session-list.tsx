import {
  EllipsisIcon,
  ExternalLinkIcon,
  GitBranchIcon,
  Trash2Icon,
} from "lucide-react";
import { Fragment, useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

import type { SessionSummary } from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import { removeSession } from "../api";
import { useDash } from "../dashboard-context";
import { openUrlOf, worktreeLabel } from "../derive";
import type { SessionEntry } from "../derive";
import { taskChip } from "../tasks";
import { Chip } from "./page";
import { PendingStack } from "./pending-cards";
import { SessionBadge } from "./status";
import { When } from "./when";

export const SessionRow = (props: {
  session: SessionSummary;
  openUrl: string;
  project?: { id: string; name: string };
  /** Set when the session works in a worktree rather than the main checkout. */
  worktree?: string;
  highlighted?: boolean;
  task?: { label: string; title: string; to?: string; model?: string };
}) => {
  const { session, openUrl, project, worktree, highlighted } = props;
  const { report } = useDash();
  const [removing, setRemoving] = useState(false);
  const waiting =
    session.status === "needs-permission" || session.status === "needs-answer";
  const remove = () => {
    const title = session.title || "Untitled session";
    const stop = session.status === "idle" ? "" : " It is stopped first.";
    if (
      !confirm(
        `Remove the session ${title}? It is deleted in opencode with its subagents.${stop} This can't be undone.`
      )
    ) {
      return;
    }
    setRemoving(true);
    removeSession(session.projectId, session.id)
      .catch(report)
      .finally(() => setRemoving(false));
  };
  const title = session.title || "Untitled session";
  const chips = props.task || worktree;
  const projectLink = project && (
    <Link
      className="text-muted-foreground hover:text-foreground truncate text-sm"
      to={`/p/${encodeURIComponent(project.id)}`}
    >
      {project.name}
    </Link>
  );
  return (
    <li
      className={cn(
        "hover:bg-muted/50 grid items-center gap-x-3.5 gap-y-1 border-t px-4 py-2 first:border-t-0",
        "max-md:grid-cols-[minmax(0,1fr)_auto]",
        project
          ? "md:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,10rem)_6rem_auto]"
          : "md:grid-cols-[8.5rem_minmax(0,1fr)_6rem_auto]",
        highlighted && "bg-attention/10 shadow-[inset_3px_0_var(--attention)]"
      )}
      id={`session-${session.id}`}
    >
      <span className="justify-self-start max-md:hidden">
        <SessionBadge status={session.status} />
      </span>
      <div className="flex min-w-0 flex-col gap-0.5 max-md:col-span-full">
        <span className="truncate" title={title}>
          {title}
        </span>
        {chips && (
          <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
            {props.task &&
              (props.task.to ? (
                <Chip
                  asChild
                  className="text-foreground hover:bg-accent hover:text-accent-foreground"
                >
                  <Link to={props.task.to} title={props.task.title}>
                    {props.task.label}
                  </Link>
                </Chip>
              ) : (
                <Chip className="text-foreground" title={props.task.title}>
                  {props.task.label}
                </Chip>
              ))}
            {props.task?.model && <Chip>{props.task.model}</Chip>}
            {worktree && (
              <Chip title={`Worktree ${worktree}`}>
                <GitBranchIcon /> {worktree}
              </Chip>
            )}
          </span>
        )}
      </div>
      {/* On phones the badge, project and time share one line under the title. */}
      <span className="flex min-w-0 items-center gap-2.5 md:hidden">
        <SessionBadge status={session.status} />
        {projectLink}
        <When
          at={session.updatedAt}
          className="text-muted-foreground text-xs whitespace-nowrap"
        />
      </span>
      {project && <span className="min-w-0 max-md:hidden">{projectLink}</span>}
      <When
        at={session.updatedAt}
        className="text-muted-foreground text-right text-xs whitespace-nowrap max-md:hidden"
      />
      <span className="inline-flex items-center gap-1 justify-self-end">
        <a
          className={cn(
            "inline-flex items-center gap-1 px-1 text-sm font-medium whitespace-nowrap hover:underline",
            waiting && !session.pending && "text-attention"
          )}
          href={sessionUrl(openUrl, session.id)}
          target="_blank"
          rel="noreferrer"
        >
          {waiting && !session.pending ? "Respond" : "Open"}{" "}
          <ExternalLinkIcon className="size-3.5" />
        </a>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground"
              aria-label={`More for ${title}`}
              disabled={removing}
            >
              <EllipsisIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={remove}>
              <Trash2Icon /> Remove session…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </li>
  );
};

export const SessionList = (props: {
  entries: SessionEntry[];
  showProject?: boolean;
  highlight?: string;
  /** Inside a checkout's own page, where the worktree chip says nothing new. */
  hideWorktree?: boolean;
}) => (
  <ul>
    {props.entries.map(({ session, view }) => (
      <Fragment key={session.id}>
        <SessionRow
          session={session}
          openUrl={openUrlOf(view, session.envId)}
          project={
            props.showProject
              ? { id: view.project.id, name: view.project.name }
              : undefined
          }
          worktree={
            props.hideWorktree
              ? undefined
              : worktreeLabel(view, session.directory)
          }
          highlighted={session.id === props.highlight}
          task={taskChip(view, session)}
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
