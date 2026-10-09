import { useParams } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  SendIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { modelShortName } from "../../../shared/tasks";
import type {
  ProjectView,
  SessionDetail,
  SessionSummary,
  SessionTurn,
} from "../../../shared/types";
import { sessionUrl } from "../../../shared/urls";
import { fetchSessionDetail, sendPrompt } from "../../api";
import { Chip, Empty, muted, Section } from "../../components/page";
import { SessionBadge } from "../../components/status";
import { Tip } from "../../components/tip";
import { When } from "../../components/when";
import { needsAttention, openUrlOf, sessionHref } from "../../derive";
import { Link } from "../../routing";
import { useCheckout } from "../checkouts/checkout-page";
import { checkoutPath } from "../checkouts/checkouts";
import type { Checkout } from "../checkouts/checkouts";
import { TurnChanges } from "../review/turn-changes";
import { formatCost, formatTokens, taskChip } from "../tasks/tasks";
import { PendingStack } from "./pending-cards";
import {
  breakdownLabel,
  contextShare,
  turnActivity,
  turnDuration,
} from "./session-detail";

/** One session of a checkout: its usage, its turns with what each changed, and a box to prompt it. */
export const SessionPage = () => {
  const { view, checkout } = useCheckout();
  const { sessionId = "" } = useParams({ strict: false });
  const session = view.sessions.find(
    (s) => s.id === sessionId && s.directory === checkout.directory
  );
  if (!session) {
    return (
      <Empty title="Unknown session">
        <p className={muted}>
          This checkout has no session {sessionId}; it may have been removed.
        </p>
        <Button asChild variant="link">
          <Link to={checkoutPath(view.project.id, checkout.target)}>
            Back to the sessions
          </Link>
        </Button>
      </Empty>
    );
  }
  return (
    <SessionView
      key={session.id}
      view={view}
      checkout={checkout}
      session={session}
    />
  );
};

const SessionView = ({
  view,
  checkout,
  session,
}: {
  view: ProjectView;
  checkout: Checkout;
  session: SessionSummary;
}) => {
  const projectId = view.project.id;
  const [detail, setDetail] = useState<SessionDetail>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(() => {
    fetchSessionDetail(projectId, session.id).then(
      (d) => {
        setDetail(d);
        setError(undefined);
      },
      (err) => setError(err instanceof Error ? err.message : String(err))
    );
  }, [projectId, session.id]);
  // The snapshot's summary changes as the session works; read the detail again each time.
  useEffect(load, [load, session.updatedAt, session.status]);

  const title = session.title || "Untitled session";
  const task = taskChip(view, session);
  const running = session.status !== "idle";
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Link
          to={checkoutPath(projectId, checkout.target)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 self-start text-sm"
        >
          <ArrowLeftIcon className="size-3.5" /> Sessions
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 className="text-xl font-semibold tracking-tight break-words">
              {title}
            </h2>
            <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs">
              <SessionBadge status={session.status} />
              {session.model && <Chip>{modelShortName(session.model)}</Chip>}
              {detail?.agent && <Chip>{detail.agent}</Chip>}
              {task &&
                (task.to ? (
                  <Chip
                    asChild
                    className="text-foreground hover:bg-accent hover:text-accent-foreground"
                  >
                    <Link to={task.to} title={task.title}>
                      {task.label}
                    </Link>
                  </Chip>
                ) : (
                  <Chip className="text-foreground" title={task.title}>
                    {task.label}
                  </Chip>
                ))}
              <span>
                updated <When at={session.updatedAt} />
              </span>
            </div>
          </div>
          <Button asChild variant="outline">
            <a
              href={sessionHref(view, session)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open in opencode <ExternalLinkIcon />
            </a>
          </Button>
        </div>
      </div>

      {session.pending && <PendingStack session={session} view={view} />}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <Alert className="border-ok/40 bg-ok/10">
          <AlertDescription className="text-ok">{notice}</AlertDescription>
        </Alert>
      )}

      <Stats session={session} detail={detail} />

      <PromptBox
        projectId={projectId}
        sessionId={session.id}
        running={running}
        onSent={setNotice}
      />

      <Section
        title="Turns"
        hint={
          detail &&
          `${detail.turns.length}${detail.more ? "+" : ""}, newest first`
        }
      >
        {!detail && !error && (
          <div className="flex flex-col gap-2 p-4">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-1/3" />
          </div>
        )}
        {detail?.turns.length === 0 && (
          <p className={cn(muted, "px-4 py-3")}>
            No turns yet: the session hasn&apos;t been prompted.
          </p>
        )}
        {detail && detail.turns.length > 0 && (
          <ol>
            {detail.turns.map((turn, i) => (
              <TurnItem
                key={turn.id}
                turn={turn}
                latest={i === 0}
                running={i === 0 && running}
                waiting={i === 0 && needsAttention(session.status)}
                projectId={projectId}
                checkout={checkout}
                sessionId={session.id}
                onSent={setNotice}
              />
            ))}
          </ol>
        )}
        {detail?.more && (
          <p className={cn(muted, "border-t px-4 py-3")}>
            Older turns are left out;{" "}
            <a
              className="underline-offset-4 hover:underline"
              href={sessionHref(view, session)}
              target="_blank"
              rel="noopener noreferrer"
            >
              open the session in opencode
            </a>{" "}
            for its whole history.
          </p>
        )}
      </Section>

      {detail && detail.subagents.length > 0 && (
        <Section title="Subagents" hint={detail.subagents.length}>
          <ul>
            {detail.subagents.map((sub) => (
              <li
                key={sub.id}
                className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-t px-4 py-2 text-sm first:border-t-0 md:grid-cols-[minmax(0,1fr)_auto_auto_auto]"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{sub.title}</span>
                  {sub.agent && <Chip>{sub.agent}</Chip>}
                </span>
                <span className="text-muted-foreground text-xs tabular-nums max-md:col-start-1">
                  {formatCost(sub.cost)} · {formatTokens(sub.tokens)} tokens
                </span>
                <When
                  at={sub.updatedAt}
                  className="text-muted-foreground text-xs whitespace-nowrap max-md:hidden"
                />
                <a
                  className="inline-flex items-center gap-1 text-sm font-medium hover:underline max-md:col-start-2 max-md:row-span-2 max-md:row-start-1"
                  href={sessionUrl(openUrlOf(view, session.envId), sub.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open <ExternalLinkIcon className="size-3.5" />
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
};

const Stat = (props: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}) => (
  <Card className="gap-1 px-4 py-3">
    <span className="text-muted-foreground text-xs font-medium">
      {props.label}
    </span>
    <span className="text-lg font-semibold tabular-nums">{props.value}</span>
    {props.children}
    {props.hint && (
      <span className="text-muted-foreground text-xs">{props.hint}</span>
    )}
  </Card>
);

const Stats = ({
  session,
  detail,
}: {
  session: SessionSummary;
  detail?: SessionDetail;
}) => {
  const share = contextShare(session.context, detail?.contextLimit);
  const withSubagents =
    detail && detail.subagents.length > 0 ? "subagents included" : undefined;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat
        label="Cost"
        value={formatCost(session.cost)}
        hint={withSubagents}
      />
      <Stat
        label="Tokens"
        value={formatTokens(session.tokens)}
        hint={
          detail?.tokens
            ? `Own: ${breakdownLabel(detail.tokens)}`
            : withSubagents
        }
      />
      <Stat
        label="Context"
        value={
          <>
            {formatTokens(session.context)}
            {detail?.contextLimit && (
              <span className="text-muted-foreground text-sm font-normal">
                {" "}
                / {formatTokens(detail.contextLimit)}
              </span>
            )}
          </>
        }
        hint={
          share === undefined
            ? "As of the latest reply"
            : `${Math.round(share * 100)}% of the window`
        }
      >
        {share !== undefined && (
          <div
            className="bg-muted h-1.5 overflow-hidden rounded-full"
            role="meter"
            aria-label="Context window used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(share * 100)}
          >
            <div
              className={cn(
                "h-full rounded-full",
                share > 0.8 ? "bg-warn" : "bg-primary"
              )}
              style={{ width: `${share * 100}%` }}
            />
          </div>
        )}
      </Stat>
      <Stat
        label="Started"
        value={detail ? <When at={detail.createdAt} /> : "—"}
        hint={detail?.outcome && `Last run ${detail.outcome}`}
      />
    </div>
  );
};

const PromptBox = (props: {
  projectId: string;
  sessionId: string;
  running: boolean;
  onSent: (notice: string) => void;
}) => {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const send = () => {
    if (!text.trim() || busy) {
      return;
    }
    setBusy(true);
    sendPrompt(props.projectId, props.sessionId, text)
      .then(
        () => {
          setText("");
          setError(undefined);
          props.onSent(
            props.running
              ? "Queued: the agent reads it when its turn ends."
              : "Sent to the agent."
          );
        },
        (err) => setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setBusy(false));
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label htmlFor="session-prompt" className="sr-only">
        Message the agent
      </label>
      <Textarea
        id="session-prompt"
        placeholder={
          props.running
            ? "Message the agent; it's queued behind the current turn…"
            : "Message the agent…"
        }
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <span className="text-muted-foreground text-xs max-sm:hidden">
          Ctrl+Enter to send
        </span>
        <Button type="submit" size="sm" disabled={busy || !text.trim()}>
          <SendIcon /> {props.running ? "Queue" : "Send"}
        </Button>
      </div>
    </form>
  );
};

const LONG_PROMPT_CHARS = 280;
const LONG_PROMPT_LINES = 3;

const TurnItem = (props: {
  turn: SessionTurn;
  latest: boolean;
  running: boolean;
  /** The session waits on a permission or an answer. */
  waiting: boolean;
  projectId: string;
  checkout: Checkout;
  sessionId: string;
  onSent: (notice: string) => void;
}) => {
  const { turn, running } = props;
  // The newest turn shows its changes from the start; older ones on demand.
  const [open, setOpen] = useState(props.latest);
  const [whole, setWhole] = useState(false);
  const long =
    turn.prompt.length > LONG_PROMPT_CHARS ||
    turn.prompt.split("\n").length > LONG_PROMPT_LINES;
  const duration = turnDuration(turn, running);
  const activity = turnActivity(turn);
  const usage = [
    turn.cost !== undefined && formatCost(turn.cost),
    turn.tokens !== undefined && `${formatTokens(turn.tokens)} tokens`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="flex flex-col gap-2 border-t px-4 py-3 first:border-t-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p
            className={cn(
              "text-sm font-medium break-words whitespace-pre-wrap",
              long && !whole && "line-clamp-3"
            )}
          >
            {turn.prompt || "(empty prompt)"}
          </p>
          {long && (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground self-start text-xs"
              onClick={() => setWhole((w) => !w)}
            >
              {whole ? "Show less" : "Show the whole prompt"}
            </button>
          )}
        </div>
        <When
          at={turn.created}
          className="text-muted-foreground shrink-0 text-xs whitespace-nowrap"
        />
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs tabular-nums">
        {running ? (
          <span className="text-foreground inline-flex items-center gap-1">
            {props.waiting ? (
              <span className="text-attention">Waiting on you</span>
            ) : (
              <>
                <LoaderCircleIcon className="size-3 animate-spin" /> Working
              </>
            )}
          </span>
        ) : (
          duration && <span>{duration}</span>
        )}
        {usage && <span>{usage}</span>}
        {activity && <span>{activity}</span>}
        {turn.model && (
          <Tip label={turn.agent ? `Agent ${turn.agent}` : "Model"}>
            <span>{modelShortName(turn.model)}</span>
          </Tip>
        )}
      </div>
      {turn.reply && (
        <blockquote className="text-muted-foreground line-clamp-6 border-l-2 pl-3 text-sm break-words whitespace-pre-wrap">
          {turn.reply}
        </blockquote>
      )}
      {turn.error && (
        <p className="text-destructive text-sm break-words">{turn.error}</p>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="-ml-2 self-start"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />} Changes
        {turn.files > 0 && (
          <span className="text-muted-foreground">({turn.files})</span>
        )}
      </Button>
      {open && (
        <TurnChanges
          projectId={props.projectId}
          target={props.checkout.target}
          directory={props.checkout.directory}
          sessionId={props.sessionId}
          turn={turn}
          latest={props.latest}
          running={running}
          onSent={props.onSent}
        />
      )}
    </li>
  );
};
