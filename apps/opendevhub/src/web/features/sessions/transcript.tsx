import {
  Attachment,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from "@opendevhub/ui/attachment";
import { Bubble, BubbleContent } from "@opendevhub/ui/bubble";
import { Button } from "@opendevhub/ui/button";
import { CodeBlock, CodeBlockContent } from "@opendevhub/ui/code-block";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@opendevhub/ui/collapsible";
import { Marker, MarkerContent, MarkerIcon } from "@opendevhub/ui/marker";
import { Message, MessageContent } from "@opendevhub/ui/message";
import { MessageScrollerItem } from "@opendevhub/ui/message-scroller";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@opendevhub/ui/trace";
import {
  BotIcon,
  CircleCheckIcon,
  ChevronRightIcon,
  ClipboardListIcon,
  FileIcon,
  FilePenIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  HistoryIcon,
  ImageIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";

import type {
  TranscriptAttachment,
  TranscriptMessage,
  TranscriptPart,
} from "../../../shared/types";
import { MarkdownBody } from "../../components/markdown-body";
import { muted } from "../../components/page";
import { Tip } from "../../components/tip";

/** A run of consecutive tool calls longer than this collapses to one "N tool calls" row. */
const TOOL_GROUP_MAX = 5;

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
type AgentMessage = Extract<TranscriptMessage, { role: "assistant" }>;

/** What a run of the agent's messages shows, in order: its text and reasoning, its tool calls in runs, its errors. */
type AgentItem =
  | { key: string; kind: "text"; text: string }
  /** `streaming`: it is the last part of a message the agent is still writing. */
  | {
      key: string;
      kind: "reasoning";
      text: string;
      duration?: number;
      streaming: boolean;
    }
  | { key: string; kind: "tools"; tools: ToolPart[] }
  | { key: string; kind: "error"; error: string };

type Block =
  | {
      key: string;
      kind: "user";
      text: string;
      attachments: TranscriptAttachment[];
    }
  | { key: string; kind: "agent"; items: AgentItem[] }
  | { key: string; kind: "compaction" }
  | { key: string; kind: "briefing"; text: string };

type Row =
  | Block
  | { key: string; kind: "more" }
  | { key: string; kind: "empty" }
  | { key: string; kind: "working" };

const agentItems = (messages: AgentMessage[]): AgentItem[] => {
  const items: AgentItem[] = [];
  for (const m of messages) {
    for (const [i, part] of m.parts.entries()) {
      const key = `${m.id}:${i}`;
      if (part.kind === "text") {
        items.push({ key, ...part });
        continue;
      }
      if (part.kind === "reasoning") {
        const streaming = m.completed === undefined && i === m.parts.length - 1;
        items.push({ key, ...part, streaming });
        continue;
      }
      const last = items.at(-1);
      if (last?.kind === "tools") {
        last.tools.push(part);
      } else {
        items.push({ key, kind: "tools", tools: [part] });
      }
    }
    if (m.error) {
      items.push({ error: m.error, key: `${m.id}:error`, kind: "error" });
    }
  }
  return items;
};

/** The transcript as blocks: each user message alone, and each run of assistant messages as one agent block. */
const toBlocks = (transcript: TranscriptMessage[]): Block[] => {
  const blocks: Block[] = [];
  let run: AgentMessage[] = [];
  const flush = () => {
    if (run.length > 0) {
      blocks.push({ items: agentItems(run), key: run[0].id, kind: "agent" });
      run = [];
    }
  };
  for (const m of transcript) {
    if (m.role === "assistant") {
      run.push(m);
      continue;
    }
    flush();
    if (m.role === "user") {
      blocks.push({
        attachments: m.attachments ?? [],
        key: m.id,
        kind: "user",
        text: m.text,
      });
    } else if (m.role === "briefing") {
      blocks.push({ key: m.id, kind: "briefing", text: m.text });
    } else {
      blocks.push({ key: m.id, kind: "compaction" });
    }
  }
  flush();
  return blocks;
};

/** How a tool call reads while it runs, once it is done and when it failed, by tool name. */
const TOOL_VERBS: Record<
  string,
  { doing: string; done: string; failed: string }
> = {
  bash: { doing: "Running", done: "Ran", failed: "Failed to run" },
  edit: { doing: "Editing", done: "Edited", failed: "Failed to edit" },
  glob: { doing: "Finding", done: "Found", failed: "Failed to find" },
  grep: { doing: "Searching", done: "Searched", failed: "Failed to search" },
  list: { doing: "Listing", done: "Listed", failed: "Failed to list" },
  read: { doing: "Reading", done: "Read", failed: "Failed to read" },
  webfetch: { doing: "Fetching", done: "Fetched", failed: "Failed to fetch" },
  write: { doing: "Writing", done: "Wrote", failed: "Failed to write" },
};
const OTHER_TOOL_VERBS = {
  doing: "Calling",
  done: "Called",
  failed: "Failed to call",
};

const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: TerminalIcon,
  edit: FilePenIcon,
  glob: SearchIcon,
  grep: SearchIcon,
  list: FolderIcon,
  read: FileTextIcon,
  task: BotIcon,
  todowrite: ListTodoIcon,
  webfetch: GlobeIcon,
  write: FilePenIcon,
};

/**
 * One tool call as a Trace line: what it did, and once it is done, what it returned behind a disclosure. A call
 * left running or pending once the agent stopped failed. `working`: the agent is still at it.
 */
const ToolLine = ({ tool, working }: { tool: ToolPart; working: boolean }) => {
  const verbs = TOOL_VERBS[tool.name];
  const Icon = TOOL_ICONS[tool.name] ?? WrenchIcon;
  const subject = verbs
    ? (tool.title ?? tool.name)
    : [tool.name, tool.title].filter(Boolean).join(" ");
  const { doing, done, failed } = verbs ?? OTHER_TOOL_VERBS;
  const settled = tool.status === "completed" || tool.status === "error";
  const errored = tool.status === "error" || (!settled && !working);
  let status: "running" | "pending" | "error" | undefined;
  let verb = done;
  if (errored) {
    status = "error";
    verb = failed;
  } else if (!settled) {
    status = tool.status === "pending" ? "pending" : "running";
    verb = doing;
  }
  const line = (
    <TraceLine status={status}>
      <TraceIcon>
        <Icon />
      </TraceIcon>
      <TraceTitle>
        {verb} {subject}
      </TraceTitle>
    </TraceLine>
  );
  const output =
    tool.status === "error" ? (tool.error ?? tool.output) : tool.output;
  if (!output) {
    return line;
  }
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm" variant={errored ? "destructive" : "default"}>
          <CodeBlockContent wrap className="max-h-64">
            {output}
          </CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
};

/** A run of tool calls, one line each; a long run folds into one "N tool calls" line. */
const ToolGroup = ({
  tools,
  working,
}: {
  tools: ToolPart[];
  working: boolean;
}) => {
  const lines = (
    <Trace>
      {tools.map((tool, i) => (
        // Tool calls carry no id of their own; their place in the run is stable.
        // oxlint-disable-next-line react/no-array-index-key
        <ToolLine key={i} tool={tool} working={working} />
      ))}
    </Trace>
  );
  if (tools.length <= TOOL_GROUP_MAX) {
    return lines;
  }
  const failed = tools.filter((t) => t.status === "error").length;
  const running =
    working &&
    tools.some((t) => t.status === "running" || t.status === "pending");
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status={running ? "running" : undefined}>
            <TraceIcon>
              <WrenchIcon />
            </TraceIcon>
            <TraceTitle>{tools.length} tool calls</TraceTitle>
            {failed > 0 && <TraceDescription>{failed} failed</TraceDescription>}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>{lines}</TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
};

/** Whole seconds, at least one, so a quick thought doesn't read "0s". */
const seconds = (ms: number): string =>
  `${Math.max(1, Math.round(ms / 1000))}s`;

/**
 * The agent's thinking: open while it thinks, closed once it is done, unless the user opened or closed it. `duration`
 * is how long it thought, in milliseconds.
 */
const Reasoning = ({
  text,
  running,
  duration,
}: {
  text: string;
  running: boolean;
  duration?: number;
}) => {
  const [open, setOpen] = useState<boolean>();
  return (
    <Trace>
      <TraceCollapsible open={open ?? running} onOpenChange={setOpen}>
        <TraceCollapsibleTrigger>
          <TraceLine status={running ? "running" : undefined}>
            <TraceIcon>
              {running ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <CircleCheckIcon />
              )}
            </TraceIcon>
            <TraceTitle>{running ? "Thinking" : "Thought"}</TraceTitle>
            {!running && duration !== undefined && (
              <TraceDescription>{seconds(duration)}</TraceDescription>
            )}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent className="whitespace-pre-wrap">
          {text}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
};

/** What the agent was told about its task, collapsed until asked for. */
const Briefing = ({ text }: { text: string }) => (
  <Collapsible className="rounded-md border">
    <CollapsibleTrigger className="hover:bg-muted/50 text-muted-foreground hover:text-foreground group flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs">
      <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
      <ClipboardListIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="font-medium">Task briefing</span>
    </CollapsibleTrigger>
    <CollapsibleContent className="border-t px-3 py-2.5">
      <MarkdownBody>{text}</MarkdownBody>
    </CollapsibleContent>
  </Collapsible>
);

const AgentItemView = ({
  item,
  working,
}: {
  item: AgentItem;
  working: boolean;
}) => {
  if (item.kind === "text") {
    return <MarkdownBody>{item.text}</MarkdownBody>;
  }
  if (item.kind === "reasoning") {
    return (
      <Reasoning
        text={item.text}
        running={working && item.streaming}
        duration={item.duration}
      />
    );
  }
  if (item.kind === "tools") {
    return <ToolGroup tools={item.tools} working={working} />;
  }
  return (
    <p
      role="alert"
      className="border-destructive/40 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-sm break-words"
    >
      {item.error}
    </p>
  );
};

/** What the agent is said to be doing while it works: a random one, changed every ten seconds. */
const WORKING_VERBS = [
  "Working",
  "Pondering",
  "Cogitating",
  "Noodling",
  "Tinkering",
  "Mulling",
  "Brewing",
  "Conjuring",
  "Percolating",
  "Ruminating",
  "Scheming",
  "Whittling",
  "Untangling",
  "Spelunking",
  "Wrangling",
  "Simmering",
  "Puzzling",
  "Finagling",
  "Hatching",
  "Clauding",
] as const;

const VERB_CHANGE_MS = 10_000;

const pickVerb = (current?: string) => {
  const others = WORKING_VERBS.filter((v) => v !== current);
  return others[Math.floor(Math.random() * others.length)];
};

const WorkingLine = () => {
  const [verb, setVerb] = useState(() => pickVerb());
  useEffect(() => {
    const timer = setInterval(
      () => setVerb((current) => pickVerb(current)),
      VERB_CHANGE_MS
    );
    return () => clearInterval(timer);
  }, []);
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <LoaderCircleIcon className="size-3.5 animate-spin" /> {verb}…
    </p>
  );
};

/** How a checkpoint above a user message is offered; left out, the transcript shows none. */
interface Checkpoints {
  onRestore: (messageId: string) => void;
  /** The agent is at work, so opencode would refuse. */
  disabled: boolean;
}

/** A checkpoint above a user message: a separator Marker whose button rewinds to before that message. */
const CheckpointMarker = ({
  messageId,
  checkpoints,
}: {
  messageId: string;
  checkpoints: Checkpoints;
}) => (
  <Marker variant="separator" className="mb-3">
    <MarkerContent className="inline-flex items-center gap-2">
      <MarkerIcon>
        <HistoryIcon />
      </MarkerIcon>
      <Tip
        label={
          checkpoints.disabled
            ? "Wait for the agent to stop before restoring"
            : "Take the conversation and the checkout's files back to before this message. Commands it ran are not undone."
        }
      >
        {/* A disabled button gets no pointer events; the span carries the tooltip. */}
        <span tabIndex={checkpoints.disabled ? 0 : undefined}>
          <Button
            size="xs"
            variant="outline"
            disabled={checkpoints.disabled}
            onClick={() => checkpoints.onRestore(messageId)}
          >
            Restore checkpoint
          </Button>
        </span>
      </Tip>
    </MarkerContent>
  </Marker>
);

/**
 * A conversation's messages, oldest at the top: the user's as bubbles, the agent's text as markdown with its
 * reasoning and tool calls collapsed. `more` says older messages are left out and links to `openHref` for them.
 */
const TranscriptRow = ({
  row,
  openHref,
  working,
  checkpoints,
}: {
  row: Row;
  openHref: string;
  working: boolean;
  checkpoints?: Checkpoints;
}) => {
  if (row.kind === "more") {
    return (
      <p className={cn(muted, "text-center text-xs")}>
        Older messages are left out;{" "}
        <a
          className="underline underline-offset-4"
          href={openHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          open the conversation in opencode
        </a>{" "}
        for its whole history.
      </p>
    );
  }
  if (row.kind === "empty") {
    return (
      <p className={cn(muted, "py-8 text-center")}>
        No messages yet: the conversation hasn&apos;t been prompted.
      </p>
    );
  }
  if (row.kind === "working") {
    return <WorkingLine />;
  }
  if (row.kind === "user") {
    return (
      <>
        {checkpoints && (
          <CheckpointMarker messageId={row.key} checkpoints={checkpoints} />
        )}
        <Message align="end">
          <MessageContent>
            {row.attachments.map((a, i) => (
              <Attachment key={`${i}:${a.name}`} size="sm">
                <AttachmentMedia>
                  {a.mime?.startsWith("image/") ? (
                    <ImageIcon aria-hidden />
                  ) : (
                    <FileIcon aria-hidden />
                  )}
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle title={a.name}>{a.name}</AttachmentTitle>
                </AttachmentContent>
              </Attachment>
            ))}
            {(row.text || row.attachments.length === 0) && (
              <Bubble align="end" variant="muted">
                {/* Keeps the line breaks of what the user typed. */}
                <BubbleContent className="whitespace-pre-wrap">
                  {row.text || "(empty message)"}
                </BubbleContent>
              </Bubble>
            )}
          </MessageContent>
        </Message>
      </>
    );
  }
  if (row.kind === "agent") {
    return (
      <Message>
        <MessageContent>
          {row.items.map((item) => (
            <AgentItemView key={item.key} item={item} working={working} />
          ))}
        </MessageContent>
      </Message>
    );
  }
  if (row.kind === "briefing") {
    return <Briefing text={row.text} />;
  }
  return (
    <div
      role="separator"
      className="text-muted-foreground flex items-center gap-3 text-xs"
    >
      <span className="bg-border h-px flex-1" />
      Conversation compacted
      <span className="bg-border h-px flex-1" />
    </div>
  );
};

/**
 * The conversation's messages as Message Scroller items, one per message: the user's anchor the scroller, so a new
 * question settles near the top and the reply streams in under it. `className` sets each item's column.
 */
export const Transcript = (props: {
  transcript: TranscriptMessage[];
  more: boolean;
  openHref: string;
  /** The agent is at it and not waiting on the user. */
  working: boolean;
  /** Offers a checkpoint above each user message; restoring rewinds to before it. */
  onRestore?: (messageId: string) => void;
  /** Turns the checkpoints off, e.g. while the session runs. */
  restoreDisabled?: boolean;
  className?: string;
}) => {
  const checkpoints = props.onRestore
    ? { disabled: props.restoreDisabled ?? false, onRestore: props.onRestore }
    : undefined;
  const rows = useMemo(() => {
    const all: Row[] = toBlocks(props.transcript);
    if (props.more) {
      all.unshift({ key: "more", kind: "more" });
    }
    if (props.transcript.every((m) => m.role === "briefing")) {
      all.push({ key: "empty", kind: "empty" });
    }
    if (props.working) {
      all.push({ key: "working", kind: "working" });
    }
    return all;
  }, [props.transcript, props.more, props.working]);
  return rows.map((row) => (
    <MessageScrollerItem
      key={row.key}
      messageId={row.key}
      scrollAnchor={row.kind === "user"}
    >
      <div className={props.className}>
        <TranscriptRow
          row={row}
          openHref={props.openHref}
          working={props.working}
          checkpoints={checkpoints}
        />
      </div>
    </MessageScrollerItem>
  ));
};
