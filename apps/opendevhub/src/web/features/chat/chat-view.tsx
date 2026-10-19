import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Button } from "@opendevhub/ui/button";
import { Skeleton } from "@opendevhub/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@opendevhub/ui/tooltip";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ArchiveIcon, ListTodoIcon } from "lucide-react";
import { useState } from "react";

import { FIRST_TURN_SENDING } from "../../../shared/tasks";
import type { ChatView as Chat, ProjectView } from "../../../shared/types";
import { taskHref } from "../../../shared/urls";
import { archiveChat, fetchChat } from "../../api";
import { Chip, Empty, muted } from "../../components/page";
import { useDash } from "../../dashboard-context";
import { Link, Navigate, useNavigate } from "../../routing";
import { CheckoutChecks } from "../checks/checks-panel";
import { SessionView } from "../sessions/session-page";
import { startStepLabel } from "../tasks/tasks";
import { conversationCheckout } from "../tasks/variant-waiting";
import { chatOf, chatPath, isTaskId, makeTaskBlocked } from "./chat";
import { ChatColumn } from "./chat-start";
import { MakeTaskDialog } from "./make-task-dialog";

/**
 * One chat: its conversation full-width and full-height, with a header naming it, its project and checkout, and
 * offering Make task and Archive; its checkout's changes and terminal are panels in the conversation's sidebar. A task id in place of the chat's (an old link) opens the task; a chat a
 * task adopted opens that task with its variant selected.
 */
export const ChatView = () => {
  const { projectId = "", chat: chatId = "" } = useParams({ strict: false });
  const { snapshot } = useDash();
  const view = snapshot?.projects.find((v) => v.project.id === projectId);
  const listed = view && chatOf(view, chatId);
  const lookup = useQuery({
    enabled: !!view && !listed && !isTaskId(chatId),
    queryFn: () => fetchChat(projectId, chatId),
    queryKey: ["chat", projectId, chatId],
    retry: false,
  });

  if (isTaskId(chatId)) {
    return <Navigate replace to={taskHref(projectId, chatId)} />;
  }
  if (!snapshot || (view && !listed && lookup.isPending)) {
    return (
      <ChatColumn centred={false}>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-40 w-full" />
      </ChatColumn>
    );
  }
  const found = lookup.data;
  if (found && "adoptedBy" in found) {
    return (
      <Navigate
        replace
        to={taskHref(projectId, found.adoptedBy.task, {
          v: found.adoptedBy.n,
        })}
      />
    );
  }
  const chat = listed ?? (found && "chat" in found ? found.chat : undefined);
  if (!view || !chat) {
    return (
      <ChatColumn centred={false}>
        <Empty title="Chat not found">
          <p className={muted}>
            It doesn&apos;t exist, or its project is no longer registered.
          </p>
          <Button asChild variant="outline">
            <Link to="/chat">New chat</Link>
          </Button>
        </Empty>
      </ChatColumn>
    );
  }
  return <ChatPage key={chat.id} view={view} chat={chat} />;
};

const ChatPage = ({ view, chat }: { view: ProjectView; chat: Chat }) => {
  const navigate = useNavigate();
  const session = chat.sessionId
    ? view.sessions.find((s) => s.id === chat.sessionId)
    : undefined;
  const directory = session?.directory ?? chat.directory;
  const checkout = directory
    ? conversationCheckout(view, directory)
    : undefined;
  const checkoutLabel =
    chat.branch ??
    checkout?.worktree?.branch ??
    checkout?.label ??
    "New worktree";
  const chips = (
    <>
      <Chip>{view.project.name}</Chip>
      <Chip>{checkoutLabel}</Chip>
      {chat.archived && <Chip>archived</Chip>}
    </>
  );
  const actions = <ChatActions view={view} chat={chat} directory={directory} />;

  return (
    <ChatColumn centred={false}>
      {/* A running chat's error is a note about its first message, e.g. that it may not have been sent. */}
      {session &&
        checkout &&
        chat.error &&
        chat.error !== FIRST_TURN_SENDING && (
          <Alert className="border-warn/40 bg-warn/10">
            <AlertDescription className="text-warn">
              {chat.error}
            </AlertDescription>
          </Alert>
        )}
      {session && checkout ? (
        <SessionView
          view={view}
          checkout={checkout}
          session={session}
          changes
          terminal
          runtime
          chips={chips}
          actions={actions}
          onStarted={(_, next) => {
            if (next) {
              void navigate(chatPath(view.project.id, next));
            }
          }}
        />
      ) : (
        <>
          <header className="flex min-w-0 flex-wrap items-center gap-2 border-b pb-2">
            <h1 className="min-w-0 truncate text-base font-semibold">
              {chat.title || "Untitled chat"}
            </h1>
            <div className="flex min-w-0 items-center gap-1.5 text-xs max-md:hidden">
              {chips}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              {actions}
            </div>
          </header>
          <div className="mx-auto w-full max-w-3xl">
            <ChatWaiting chat={chat} />
          </div>
        </>
      )}
    </ChatColumn>
  );
};

/** A chat without a conversation to show: how far its new worktree got, that it failed, or that it is gone. */
export const ChatWaiting = ({ chat }: { chat: Chat }) => {
  if (chat.sessionRemoved) {
    return (
      <Empty title="Conversation removed">
        <p className={muted}>
          This chat&apos;s conversation is gone from opencode.
        </p>
      </Empty>
    );
  }
  if (chat.step === "failed") {
    return (
      <Empty title="The chat could not start">
        {chat.error && (
          <p className="text-destructive max-w-prose text-sm break-words">
            {chat.error}
          </p>
        )}
        {chat.log && chat.log.length > 0 && <SetupLog lines={chat.log} />}
        <Button asChild variant="outline">
          <Link to="/chat">Back to Chat</Link>
        </Button>
      </Empty>
    );
  }
  const progress = chat.sessionId
    ? "Opening the conversation…"
    : `${startStepLabel(chat.step)}…`;
  return (
    <Empty title="Starting the chat">
      <p className={muted}>{progress}</p>
      {chat.log && chat.log.length > 0 && <SetupLog lines={chat.log} />}
    </Empty>
  );
};

const SetupLog = ({ lines }: { lines: string[] }) => (
  <pre className="bg-muted/50 text-muted-foreground max-h-48 w-full overflow-auto rounded-md px-3 py-2 text-left font-mono text-xs leading-relaxed whitespace-pre-wrap">
    {lines.join("\n")}
  </pre>
);

/** The chat header's buttons: Make task and Archive. */
const ChatActions = ({
  view,
  chat,
  directory,
}: {
  view: ProjectView;
  chat: Chat;
  directory?: string;
}) => {
  const navigate = useNavigate();
  const [making, setMaking] = useState(false);
  const [error, setError] = useState<string>();
  const blocked = makeTaskBlocked(view, chat);

  const archive = async () => {
    try {
      await archiveChat(view.project.id, chat.id);
      await navigate("/chat");
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_));
    }
  };

  return (
    <>
      {error && <span className="text-destructive text-xs">{error}</span>}
      {directory && (
        <CheckoutChecks projectId={view.project.id} directory={directory} />
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button gets no pointer events, so its tooltip hangs on a wrapper. */}
          <span tabIndex={blocked ? 0 : undefined}>
            <Button
              variant="outline"
              size="sm"
              disabled={blocked !== undefined}
              onClick={() => setMaking(true)}
            >
              <ListTodoIcon /> <span className="max-sm:sr-only">Make task</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {blocked ?? "Turn this chat into a task, keeping its conversation"}
        </TooltipContent>
      </Tooltip>
      {!chat.archived && (
        <Button
          variant="ghost"
          size="sm"
          aria-label="Archive chat"
          title="Archive: hide this chat; its conversation keeps running"
          onClick={() => void archive()}
        >
          <ArchiveIcon />
        </Button>
      )}
      {making && (
        <MakeTaskDialog
          view={view}
          chat={chat}
          onClose={() => setMaking(false)}
        />
      )}
    </>
  );
};
