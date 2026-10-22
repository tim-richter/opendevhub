import { Button } from "@opendevhub/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@opendevhub/ui/select";
import { Skeleton } from "@opendevhub/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@opendevhub/ui/tooltip";
import { GitBranchIcon, ListTodoIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type {
  ComposerSendRequest,
  DashboardSnapshot,
} from "../../../shared/types";
import { startChat } from "../../api";
import { Empty, muted } from "../../components/page";
import { useDash } from "../../dashboard-context";
import { useNavigate, useSearchParams } from "../../routing";
import { useCurrentProject } from "../../shell/current-project";
import { Logo } from "../../shell/logo";
import { Composer } from "../sessions/composer";
import {
  CHAT_PROMPT_PARAM,
  WORKTREES_UNAVAILABLE,
  canCreateWorktree,
  chatPath,
  chatTarget,
  checkoutChoices,
  defaultCheckoutChoice,
  rememberProject,
} from "./chat";

/** How long a started chat waits for the snapshot to list it before opening its view anyway. */
const CHAT_WAIT_MS = 10_000;

/** A started chat the page waits to see in the snapshot. */
interface Waiting {
  projectId: string;
  chat: string;
  done: () => void;
}

const lists = (snapshot: DashboardSnapshot | undefined, w: Waiting) =>
  snapshot?.projects
    .find((v) => v.project.id === w.projectId)
    ?.chats.some((c) => c.id === w.chat) === true;

/**
 * Chat's start page: the composer centred on an empty page, with the project and the checkout it starts in.
 * The first message starts a chat there, and the page moves on to that chat's view; Start as task hands the
 * message to the New task dialog instead. A `prompt` search param prefills the composer.
 */
export const ChatStart = () => {
  const { snapshot, openAddProject, newTask } = useDash();
  const navigate = useNavigate();
  const { view } = useCurrentProject();
  const [params] = useSearchParams();
  // A to-do (or other page) can hand over a first message; the composer starts with it.
  const prompt = params.get(CHAT_PROMPT_PARAM) ?? undefined;
  const [choice, setChoice] = useState<string>();
  const [text, setText] = useState(prompt ?? "");
  const [shownPrompt, setShownPrompt] = useState(prompt);
  if (prompt !== shownPrompt) {
    setShownPrompt(prompt);
    setText(prompt ?? "");
  }
  const waiting = useRef<Waiting>(undefined);
  const latest = useRef(snapshot);

  // The view opens once the snapshot lists the new chat, so it shows the chat at once.
  useEffect(() => {
    latest.current = snapshot;
    const w = waiting.current;
    if (w && lists(snapshot, w)) {
      w.done();
    }
  }, [snapshot]);

  if (!snapshot) {
    return (
      <ChatColumn>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
      </ChatColumn>
    );
  }
  if (!view) {
    return (
      <ChatColumn>
        <Empty title="No projects yet">
          <p className={muted}>
            Add a project to chat with an agent in one of its checkouts.
          </p>
          <Button variant="outline" onClick={openAddProject}>
            Add project
          </Button>
        </Empty>
      </ChatColumn>
    );
  }
  const choices = checkoutChoices(view);
  const selected =
    choices.find((c) => c.value === choice && !c.disabled)?.value ??
    defaultCheckoutChoice(view);
  const { directory, label, target } = chatTarget(view, selected);
  const { id } = view.project;

  const send = async (message: ComposerSendRequest) => {
    const { chat } = await startChat(id, { message, target });
    rememberProject(id);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CHAT_WAIT_MS);
      const w: Waiting = {
        chat,
        done: () => {
          clearTimeout(timer);
          resolve();
        },
        projectId: id,
      };
      waiting.current = w;
      if (lists(latest.current, w)) {
        w.done();
      }
    });
    waiting.current = undefined;
    await navigate(chatPath(id, chat), { replace: true });
    return undefined;
  };

  const ghost =
    "text-muted-foreground hover:text-foreground hover:bg-accent dark:bg-transparent dark:hover:bg-accent h-7 w-auto max-w-[60%] gap-1 border-0 bg-transparent px-2 text-xs shadow-none";

  return (
    <ChatColumn>
      <h1 className="flex items-center justify-center gap-3 text-center text-3xl font-medium tracking-tight sm:text-4xl">
        <Logo size={36} className="text-primary" />
        What shall we build?
      </h1>
      <Composer
        key={prompt}
        initialText={prompt}
        view={view}
        directory={directory}
        checkoutLabel={label}
        running={false}
        hubCommands={false}
        hero
        autoFocus
        onSend={send}
        onTextChange={setText}
        footer={
          <div className="flex flex-col gap-1 px-1">
            <div className="text-muted-foreground flex items-center gap-1 text-xs">
              <span className="px-2">
                In{" "}
                <span className="text-foreground font-medium">
                  {view.project.name}
                </span>
              </span>
              <Select value={selected} onValueChange={setChoice}>
                <SelectTrigger aria-label="Checkout" className={ghost}>
                  <GitBranchIcon />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper" align="start">
                  {choices.map((c) => (
                    <SelectItem
                      key={c.value}
                      value={c.value}
                      disabled={c.disabled}
                    >
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ml-auto h-7 gap-1 px-2 text-xs"
                    onClick={() =>
                      newTask(id, text.trim() ? { prompt: text } : undefined)
                    }
                  >
                    <ListTodoIcon /> Start as task
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Open New task with this message as its prompt
                </TooltipContent>
              </Tooltip>
            </div>
            {!canCreateWorktree(view) && (
              <p className="text-muted-foreground px-2 text-xs">
                New worktree: {WORKTREES_UNAVAILABLE}
              </p>
            )}
          </div>
        }
      />
    </ChatColumn>
  );
};

/** The column Chat's pages share, so the composer doesn't jump sideways after the first message. */
export const ChatColumn = (props: {
  children: ReactNode;
  centred?: boolean;
}) => (
  <div
    className={
      props.centred === false
        ? // A chat fills its workspace, so its composer sits at the bottom.
          "flex min-h-0 w-full flex-1 flex-col gap-4"
        : // Centred in its workspace, the one page that isn't anchored to the left; the bottom padding matches the
          // shell's top padding, so the content sits in the true middle.
          "mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 pb-4 md:pb-6"
    }
  >
    {props.children}
  </div>
);
