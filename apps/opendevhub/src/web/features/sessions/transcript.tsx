import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@opendevhub/ui/collapsible";
import {
  BrainIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  ClipboardListIcon,
  FileIcon,
  ImageIcon,
  LoaderCircleIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";

import type {
  TranscriptAttachment,
  TranscriptMessage,
  TranscriptPart,
} from "../../../shared/types";
import { MarkdownBody } from "../../components/markdown-body";
import { muted } from "../../components/page";

/** A run of consecutive tool calls longer than this collapses to one "N tool calls" row. */
const TOOL_GROUP_MAX = 5;

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
type AgentMessage = Extract<TranscriptMessage, { role: "assistant" }>;

/** What a run of the agent's messages shows, in order: its text and reasoning, its tool calls in runs, its errors. */
type AgentItem =
  | { key: string; kind: "text"; text: string }
  | { key: string; kind: "reasoning"; text: string }
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
  | Exclude<Block, { kind: "agent" }>
  | { key: string; kind: "agent-item"; item: AgentItem; lastInRun: boolean }
  | { key: string; kind: "more" }
  | { key: string; kind: "empty" }
  | { key: string; kind: "working" };

const agentItems = (messages: AgentMessage[]): AgentItem[] => {
  const items: AgentItem[] = [];
  for (const m of messages) {
    for (const [i, part] of m.parts.entries()) {
      const key = `${m.id}:${i}`;
      if (part.kind === "text" || part.kind === "reasoning") {
        items.push({ key, ...part });
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

const STATUS_ICON = {
  completed: { icon: CheckIcon, label: "Done", tone: "text-ok" },
  error: { icon: XIcon, label: "Failed", tone: "text-destructive" },
  pending: {
    icon: CircleDashedIcon,
    label: "Pending",
    tone: "text-muted-foreground",
  },
  running: {
    icon: LoaderCircleIcon,
    label: "Running",
    tone: "text-muted-foreground animate-spin",
  },
} as const;

const ToolRow = ({ tool }: { tool: ToolPart }) => {
  const { icon: Icon, label, tone } = STATUS_ICON[tool.status];
  return (
    <li className="flex min-w-0 items-center gap-2 px-2.5 py-1 text-xs">
      <Icon className={cn("size-3.5 shrink-0", tone)} aria-label={label} />
      <span className="font-mono font-medium">{tool.name}</span>
      {tool.title && (
        <span className="text-muted-foreground min-w-0 truncate font-mono">
          {tool.title}
        </span>
      )}
    </li>
  );
};

const ToolGroup = ({ tools }: { tools: ToolPart[] }) => {
  const [open, setOpen] = useState(false);
  const rows = (
    <ul className="divide-y">
      {tools.map((tool, i) => (
        // Tool calls carry no id of their own; their place in the run is stable.
        // oxlint-disable-next-line react/no-array-index-key
        <ToolRow key={i} tool={tool} />
      ))}
    </ul>
  );
  if (tools.length <= TOOL_GROUP_MAX) {
    return <div className="rounded-md border">{rows}</div>;
  }
  const failed = tools.filter((t) => t.status === "error").length;
  const working = tools.some((t) => t.status === "running");
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-md border"
    >
      <CollapsibleTrigger className="hover:bg-muted/50 flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs">
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="font-medium">{tools.length} tool calls</span>
        {failed > 0 && (
          <span className="text-destructive">{failed} failed</span>
        )}
        {working && (
          <LoaderCircleIcon
            className="text-muted-foreground size-3.5 animate-spin"
            aria-label="Running"
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t">{rows}</CollapsibleContent>
    </Collapsible>
  );
};

const Thinking = ({ text }: { text: string }) => (
  <Collapsible>
    <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1.5 text-xs">
      <ChevronRightIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-90" />
      <BrainIcon className="size-3.5" /> Thinking
    </CollapsibleTrigger>
    <CollapsibleContent>
      <p className="text-muted-foreground mt-1.5 border-l-2 pl-3 text-xs break-words whitespace-pre-wrap">
        {text}
      </p>
    </CollapsibleContent>
  </Collapsible>
);

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

const AgentItemView = ({ item }: { item: AgentItem }) => {
  if (item.kind === "text") {
    return <MarkdownBody>{item.text}</MarkdownBody>;
  }
  if (item.kind === "reasoning") {
    return <Thinking text={item.text} />;
  }
  if (item.kind === "tools") {
    return <ToolGroup tools={item.tools} />;
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

/**
 * A conversation's messages, oldest at the top: the user's as bubbles, the agent's text as markdown with its
 * reasoning and tool calls collapsed. `more` says older messages are left out and links to `openHref` for them.
 */
const TranscriptRow = ({ row, openHref }: { row: Row; openHref: string }) => {
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
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <LoaderCircleIcon className="size-3.5 animate-spin" /> Working
      </p>
    );
  }
  if (row.kind === "user") {
    return (
      <div className="flex flex-col items-end">
        <div className="flex max-w-[85%] flex-col items-end gap-1.5">
          {row.attachments.length > 0 && (
            <ul
              aria-label="Attached files"
              className="flex flex-wrap justify-end gap-1.5"
            >
              {row.attachments.map((a, i) => (
                <li
                  key={`${i}:${a.name}`}
                  className="bg-muted text-muted-foreground flex max-w-56 items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                >
                  {a.mime?.startsWith("image/") ? (
                    <ImageIcon className="size-3.5 shrink-0" aria-hidden />
                  ) : (
                    <FileIcon className="size-3.5 shrink-0" aria-hidden />
                  )}
                  <span className="truncate" title={a.name}>
                    {a.name}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {(row.text || row.attachments.length === 0) && (
            <div className="bg-muted rounded-2xl rounded-br-sm px-4 py-2.5 text-sm break-words whitespace-pre-wrap">
              {row.text || "(empty message)"}
            </div>
          )}
        </div>
      </div>
    );
  }
  if (row.kind === "briefing") {
    return <Briefing text={row.text} />;
  }
  if (row.kind === "compaction") {
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
  }
  return <AgentItemView item={row.item} />;
};

export const Transcript = (props: {
  transcript: TranscriptMessage[];
  more: boolean;
  openHref: string;
  /** The agent is at it and not waiting on the user. */
  working: boolean;
}) => {
  const rows = useMemo(() => {
    const flattened: Row[] = [];
    for (const block of toBlocks(props.transcript)) {
      if (block.kind === "agent") {
        for (const [index, item] of block.items.entries()) {
          flattened.push({
            item,
            key: item.key,
            kind: "agent-item",
            lastInRun: index === block.items.length - 1,
          });
        }
      } else {
        flattened.push(block);
      }
    }
    if (props.more) {
      flattened.unshift({ key: "more", kind: "more" });
    }
    if (props.transcript.every((m) => m.role === "briefing")) {
      flattened.push({ key: "empty", kind: "empty" });
    }
    if (props.working) {
      flattened.push({ key: "working", kind: "working" });
    }
    return flattened;
  }, [props.transcript, props.more, props.working]);
  return (
    <div className="w-full">
      {rows.map((row) => (
        <div
          key={row.key}
          className={
            row.kind === "agent-item" && !row.lastInRun ? "pb-2.5" : "pb-5"
          }
        >
          <TranscriptRow row={row} openHref={props.openHref} />
        </div>
      ))}
    </div>
  );
};
