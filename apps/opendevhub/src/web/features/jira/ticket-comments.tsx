import {
  ChevronsUpIcon,
  ExternalLinkIcon,
  MessageSquareIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Ref } from "react";

import { cn } from "@/lib/utils";

import type { JiraComment, JiraTicket } from "../../../shared/jira";
import { MarkdownBody } from "../../components/markdown-body";
import { When } from "../../components/when";
import { PersonAvatar } from "./ticket-labels";

/** Longer threads open on their latest comments, the earlier ones a click away. */
const COLLAPSE_ABOVE = 5;
const SHOWN_WHEN_COLLAPSED = 3;

const commentUrl = (ticket: JiraTicket, comment: JiraComment) =>
  `${ticket.url}?focusedCommentId=${encodeURIComponent(comment.id)}#comment-${encodeURIComponent(comment.id)}`;

const roleOf = (ticket: JiraTicket, author: string) => {
  if (author === ticket.reporter) {
    return "Reporter";
  }
  return author === ticket.assignee ? "Assignee" : undefined;
};

const Comment = (props: {
  ticket: JiraTicket;
  comment: JiraComment;
  last: boolean;
  revealed: boolean;
  articleRef?: Ref<HTMLElement>;
}) => {
  const { ticket, comment } = props;
  const role = roleOf(ticket, comment.author);
  return (
    <li
      className={cn(
        "relative flex gap-3 pb-5 last:pb-0",
        props.revealed &&
          "animate-in fade-in slide-in-from-top-1 motion-reduce:slide-in-from-top-0 duration-200 ease-out"
      )}
    >
      {!props.last && (
        <span
          aria-hidden
          className="bg-border absolute top-10 bottom-1 left-4 w-px -translate-x-1/2"
        />
      )}
      <PersonAvatar name={comment.author} size="default" className="mt-0.5" />
      <article
        aria-label={`Comment by ${comment.author}`}
        tabIndex={props.articleRef ? -1 : undefined}
        ref={props.articleRef}
        className="bg-card focus-visible:outline-ring min-w-0 flex-1 rounded-lg border focus-visible:outline-2"
      >
        <header className="bg-muted/40 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-t-lg border-b px-4 py-2 text-sm">
          <span className="min-w-0 truncate font-medium">{comment.author}</span>
          {role && (
            <span className="text-muted-foreground rounded-md border px-1.5 py-px text-[0.6875rem] leading-4 font-medium">
              {role}
            </span>
          )}
          <a
            href={commentUrl(ticket, comment)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-muted-foreground hover:text-foreground focus-visible:outline-ring rounded-sm text-xs transition-colors hover:underline focus-visible:outline-2"
          >
            <When at={comment.createdAt} />
          </a>
          {comment.updatedAt && (
            <span className="text-muted-foreground text-xs">
              ·{" "}
              <span title={new Date(comment.updatedAt).toLocaleString()}>
                edited
              </span>
            </span>
          )}
        </header>
        <MarkdownBody className="text-foreground/90 px-4 py-3">
          {comment.body}
        </MarkdownBody>
      </article>
    </li>
  );
};

/** The ticket's discussion as a thread, oldest first like Jira, so it reads top to bottom. */
export const TicketComments = ({ ticket }: { ticket: JiraTicket }) => {
  const { comments, commentTotal } = ticket;
  const [expanded, setExpanded] = useState(false);
  const hidden =
    !expanded && comments.length > COLLAPSE_ABOVE
      ? comments.length - SHOWN_WHEN_COLLAPSED
      : 0;
  const [revealed, setRevealed] = useState(0);
  // The button that revealed the earlier comments is gone, so focus moves to the first of them.
  const firstRevealed = useRef<HTMLElement>(null);
  useEffect(() => {
    if (revealed > 0) {
      firstRevealed.current?.focus();
    }
  }, [revealed]);
  const missing = commentTotal - comments.length;
  return (
    <section aria-labelledby="jira-comments-title">
      <h2
        id="jira-comments-title"
        className="mb-4 flex items-center gap-2 text-base font-semibold"
      >
        Comments
        {commentTotal > 0 && (
          <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
            {commentTotal}
          </span>
        )}
      </h2>
      {comments.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-8 text-center text-sm">
          <MessageSquareIcon className="size-5 opacity-60" aria-hidden />
          <p>No comments yet.</p>
          <a
            href={ticket.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground focus-visible:outline-ring inline-flex items-center gap-1 rounded-sm text-xs font-medium underline-offset-4 transition-colors hover:underline focus-visible:outline-2"
          >
            Start the discussion in Jira <ExternalLinkIcon className="size-3" />
          </a>
        </div>
      ) : (
        <ol className="relative">
          {hidden > 0 && (
            <li className="relative flex items-center gap-3 pb-5">
              <span
                aria-hidden
                className="bg-border absolute top-8 bottom-0 left-4 w-px -translate-x-1/2"
              />
              <span
                aria-hidden
                className="text-muted-foreground border-border bg-background flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed"
              >
                <ChevronsUpIcon className="size-3.5" />
              </span>
              <button
                type="button"
                onClick={() => {
                  setRevealed(hidden);
                  setExpanded(true);
                }}
                className="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-ring rounded-md px-2 py-1 text-sm font-medium transition-[color,background-color,transform] duration-150 ease-out focus-visible:outline-2 active:scale-[0.97]"
              >
                Show {hidden} earlier {hidden === 1 ? "comment" : "comments"}
              </button>
            </li>
          )}
          {comments.slice(hidden).map((comment, i) => (
            <Comment
              key={comment.id}
              ticket={ticket}
              comment={comment}
              last={i === comments.length - hidden - 1}
              revealed={i < revealed}
              {...(revealed > 0 && i === 0
                ? { articleRef: firstRevealed }
                : {})}
            />
          ))}
        </ol>
      )}
      {missing > 0 && (
        <p className="text-muted-foreground mt-4 text-sm">
          Jira sent {comments.length} of {commentTotal} comments.{" "}
          <a
            href={ticket.url}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-foreground focus-visible:outline-ring inline-flex items-center gap-1 rounded-sm font-medium underline-offset-4 transition-colors hover:underline focus-visible:outline-2"
          >
            Read the rest in Jira <ExternalLinkIcon className="size-3" />
          </a>
        </p>
      )}
    </section>
  );
};
