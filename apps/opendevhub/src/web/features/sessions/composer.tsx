import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@opendevhub/ui/attachment";
import { Button } from "@opendevhub/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@opendevhub/ui/command";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@opendevhub/ui/input-group";
import { Popover, PopoverAnchor, PopoverContent } from "@opendevhub/ui/popover";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ArrowUpIcon,
  BotIcon,
  FileIcon,
  ListEndIcon,
  PlayIcon,
  PlusIcon,
  SquareSlashIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useShortcut, useShortcutLabel } from "@/shell/use-shortcut";

import type {
  ComposerSendRequest,
  ComposerSendResult,
  ModelRef,
  ProjectView,
} from "../../../shared/types";
import {
  envAction,
  fetchComposerAgents,
  fetchComposerCommands,
  fetchModels,
  searchComposerFiles,
} from "../../api";
import { StatusDot } from "../../components/status";
import { Tip } from "../../components/tip";
import { useDash } from "../../dashboard-context";
import { envOfDirectory, envTone } from "../../derive";
import { AgentPicker } from "./agent-picker";
import { addAttachments, formatSize } from "./attachments";
import type { PendingAttachment } from "./attachments";
import { caretCoordinates } from "./caret";
import {
  deleteMentionBefore,
  insertCommand,
  insertMention,
  rebase,
  triggerAt,
} from "./composer-text";
import type { ComposerValue, Trigger } from "./composer-text";
import { ModelPicker } from "./model-picker";

const FILE_DEBOUNCE_MS = 150;
const SUGGESTION_LIMIT = 50;
const LOOKUP_STALE_MS = 60_000;

/** One row of the suggestion list. */
interface Suggestion {
  key: string;
  group: "Commands" | "Files" | "Agents";
  label: string;
  description?: string;
  note?: string;
  disabled?: boolean;
  choose: () => void;
}

const matchRank = (name: string, query: string): number => {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n.startsWith(q)) {
    return 0;
  }
  return n.includes(q) ? 1 : -1;
};

/** Items matching `query`, the ones starting with it first. */
const ranked = <T,>(items: T[], query: string, name: (item: T) => string) =>
  items
    .map((item) => ({ item, rank: matchRank(name(item), query) }))
    .filter((r) => r.rank >= 0)
    .toSorted((a, b) => a.rank - b.rank)
    .map((r) => r.item);

const useDebounced = <T,>(value: T, ms: number): T => {
  const [current, setCurrent] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setCurrent(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return current;
};

const sentNotice = (result: ComposerSendResult): string => {
  switch (result.kind) {
    case "command": {
      return result.queued
        ? `Queued /${result.name}: it runs when the current turn ends.`
        : `Running /${result.name}.`;
    }
    case "interrupt": {
      return "Stopped the running turn.";
    }
    case "new": {
      return "Started a new conversation in this checkout.";
    }
    default: {
      return result.queued
        ? "Queued: the agent reads it when its turn ends."
        : "Sent to the agent.";
    }
  }
};

const commandNote = (c: { hub?: boolean; shadowed?: boolean }) => {
  if (c.hub) {
    return "hub";
  }
  return c.shadowed ? "hidden by the hub's command" : undefined;
};

const sameModel = (a: ModelRef | undefined, b: ModelRef | undefined) =>
  a?.id === b?.id &&
  a?.providerID === b?.providerID &&
  (a?.variant ?? "default") === (b?.variant ?? "default");

/** The files a drag or paste carries, if any. */
const filesOf = (data: DataTransfer | null): File[] =>
  data ? [...data.files] : [];

/** Where the composer sends: the checkout's own container, else the project's. */
const targetOf = (view: ProjectView, directory: string) => {
  const env = envOfDirectory(view, directory);
  const runtime = env?.runtime ?? view.runtime;
  const ready =
    runtime.containerState === "running" && runtime.opencode === "healthy";
  return {
    envId: env?.id,
    label: env ? "worktree container" : "project container",
    ready,
    /** Stopped or failed: a Start would bring it up. */
    startable:
      runtime.containerState === "stopped" ||
      runtime.containerState === "error",
    starting:
      runtime.containerState === "starting" || runtime.opencode === "starting",
    tone: envTone({ runtime }),
    why: env
      ? "This worktree's container isn't running: start it to send."
      : "The project's container isn't running: start it to send.",
  };
};

/** Starts the container the composer sends to: the worktree's own, else the project's. */
const StartContainer = (props: {
  projectId: string;
  envId: string | undefined;
  startable: boolean;
  starting: boolean;
}) => {
  const { act, report } = useDash();
  const [asked, setAsked] = useState(false);
  // The snapshot reports "starting" shortly after the request; until then the click itself counts.
  useEffect(() => {
    if (!props.startable) {
      setAsked(false);
    }
  }, [props.startable]);
  if (!props.startable && !props.starting) {
    return null;
  }
  const busy = props.starting || asked;
  const start = () => {
    setAsked(true);
    if (props.envId === undefined) {
      act(props.projectId, "start");
      return;
    }
    envAction(props.projectId, props.envId, "start").catch((error: unknown) => {
      setAsked(false);
      report(error);
    });
  };
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 px-2 text-xs"
      disabled={busy}
      onClick={start}
    >
      <PlayIcon className="size-3" />
      {busy ? "Starting…" : "Start"}
    </Button>
  );
};

/**
 * The message box of a conversation and of Chat's start page: a card with the text on top and a toolbar under it
 * (attach, agent, model, send). `/` suggests commands at the start of the message and `@` suggests files and
 * agents. The caller sends what it holds.
 */
export const Composer = (props: {
  view: ProjectView;
  /** The checkout whose commands, files and agents it suggests; for a new worktree, the main checkout. */
  directory: string;
  /** The checkout it sends to, named when its environment isn't running. */
  checkoutLabel: string;
  /** A turn is running: a message is queued behind it. */
  running: boolean;
  /** Suggest the hub's `/new` and `/interrupt`, which need a conversation. */
  hubCommands: boolean;
  /** Resolving clears the box; rejecting keeps it and shows the error. */
  onSend: (
    message: ComposerSendRequest
  ) => Promise<ComposerSendResult | undefined>;
  /** What a send did, as a sentence. */
  onSent?: (notice: string) => void;
  autoFocus?: boolean;
  /** A taller box; for Chat's start page. */
  hero?: boolean;
  /** Under the box, inside the form; on Chat's start page, the picker of where the message goes. */
  footer?: ReactNode;
  /** The model the conversation uses; the picker starts at it, else at the project's default. */
  model?: ModelRef;
  /** The agent the conversation uses; the picker starts at it, else at the first agent opencode lists. */
  agent?: string;
  /** What the box starts with; for stories. */
  initialText?: string;
  /** Text to put in the box each time `key` changes, unless the box already holds a draft. */
  fill?: { text: string; key: number };
  /** Hears the text as it is typed; Chat's start page hands it to a new task. */
  onTextChange?: (text: string) => void;
}) => {
  const {
    view,
    directory,
    running,
    hubCommands,
    hero = false,
    onTextChange,
  } = props;
  const projectId = view.project.id;
  const target = targetOf(view, directory);

  const [value, setValue] = useState<ComposerValue>({
    mentions: [],
    text: props.initialText ?? "",
  });
  const [caret, setCaret] = useState(props.initialText?.length ?? 0);
  const [focused, setFocused] = useState(props.initialText !== undefined);
  const [dismissed, setDismissed] = useState<number>();
  const [activeKey, setActiveKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => onTextChange?.(value.text), [onTextChange, value.text]);
  const list = useRef<HTMLDivElement>(null);
  const pendingCaret = useRef<number>(undefined);
  const [anchor, setAnchor] = useState({ left: 0, top: 0 });
  const [aria, setAria] = useState<{ list?: string; active?: string }>({});
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [chosenModel, setChosenModel] = useState<ModelRef>();
  const [chosenAgent, setChosenAgent] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const models = useQuery({
    enabled: target.ready,
    queryFn: () => fetchModels(projectId),
    queryKey: ["models", projectId],
    staleTime: LOOKUP_STALE_MS,
  });
  const shownModel = chosenModel ?? props.model ?? models.data?.default;
  // Only a model the user picked is sent, and only when it isn't already the conversation's.
  const sentModel =
    chosenModel && !sameModel(chosenModel, props.model)
      ? chosenModel
      : undefined;
  // Without a pick or a conversation agent, the first primary agent opencode lists, sent so it is the one that runs.
  const shownAgent = chosenAgent ?? props.agent ?? models.data?.agents[0]?.id;
  const sentAgent =
    shownAgent && shownAgent !== props.agent ? shownAgent : undefined;

  const attach = async (added: File[]) => {
    if (added.length === 0) {
      return;
    }
    try {
      setAttachments(await addAttachments(attachments, added));
      setError(undefined);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_));
    }
  };
  const onDragOver = (e: DragEvent) => {
    if (!target.ready || !e.dataTransfer.types.includes("Files")) {
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    setDragging(false);
    if (!target.ready) {
      return;
    }
    const dropped = filesOf(e.dataTransfer);
    if (dropped.length > 0) {
      e.preventDefault();
      void attach(dropped);
    }
  };

  const trigger: Trigger | undefined =
    focused && target.ready ? triggerAt(value, caret) : undefined;
  const open = trigger !== undefined && trigger.start !== dismissed;
  const fileQuery = useDebounced(
    trigger?.kind === "mention" ? trigger.query : undefined,
    FILE_DEBOUNCE_MS
  );

  const commands = useQuery({
    enabled: open && trigger?.kind === "command",
    queryFn: () => fetchComposerCommands(projectId, directory),
    queryKey: ["composer-commands", projectId, directory],
    staleTime: LOOKUP_STALE_MS,
  });
  const agents = useQuery({
    enabled: open && trigger?.kind === "mention",
    queryFn: () => fetchComposerAgents(projectId, directory),
    queryKey: ["composer-agents", projectId, directory],
    staleTime: LOOKUP_STALE_MS,
  });
  const files = useQuery({
    enabled: open && fileQuery !== undefined,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      searchComposerFiles(projectId, directory, fileQuery ?? "", signal),
    queryKey: ["composer-files", projectId, directory, fileQuery],
  });

  const apply = (next: { value: ComposerValue; caret: number }) => {
    setValue(next.value);
    setCaret(next.caret);
    pendingCaret.current = next.caret;
  };

  const suggestions: Suggestion[] = [];
  if (open && trigger.kind === "command") {
    for (const c of ranked(
      (commands.data?.commands ?? []).filter((x) => hubCommands || !x.hub),
      trigger.query,
      (x) => x.name
    )) {
      suggestions.push({
        choose: () => apply(insertCommand(value, caret, c.name)),
        description: c.description,
        disabled: c.shadowed,
        group: "Commands",
        key: `command:${c.shadowed ? "shadowed:" : ""}${c.name}`,
        label: `/${c.name}`,
        note: commandNote(c),
      });
    }
  }
  if (open && trigger.kind === "mention") {
    for (const path of (files.data?.files ?? []).slice(0, SUGGESTION_LIMIT)) {
      suggestions.push({
        choose: () =>
          apply(
            insertMention(value, trigger, caret, { kind: "file", name: path })
          ),
        group: "Files",
        key: `file:${path}`,
        label: path,
      });
    }
    for (const a of ranked(
      agents.data?.agents ?? [],
      trigger.query,
      (x) => x.id
    )) {
      suggestions.push({
        choose: () =>
          apply(
            insertMention(value, trigger, caret, { kind: "agent", name: a.id })
          ),
        description: a.description,
        group: "Agents",
        key: `agent:${a.id}`,
        label: `@${a.id}`,
      });
    }
  }
  const selectable = suggestions.filter((s) => !s.disabled);
  const active =
    selectable.find((s) => s.key === activeKey) ?? selectable.at(0);

  // A new fill goes in only when the box is empty, so a draft is never lost.
  const fillKey = props.fill?.key;
  const fillText = props.fill?.text;
  const filledKey = useRef(fillKey);
  useEffect(() => {
    if (fillKey === filledKey.current) {
      return;
    }
    filledKey.current = fillKey;
    if (fillText === undefined || value.text.trim() || attachments.length > 0) {
      return;
    }
    setValue({ mentions: [], text: fillText });
    setCaret(fillText.length);
    pendingCaret.current = fillText.length;
    setFocused(true);
    textarea.current?.focus();
  }, [fillKey, fillText, value.text, attachments.length]);

  // Put the caret where an insertion left it, once the textarea holds the new text.
  useLayoutEffect(() => {
    const at = pendingCaret.current;
    if (at !== undefined && textarea.current) {
      pendingCaret.current = undefined;
      textarea.current.setSelectionRange(at, at);
    }
  });

  // Anchor the list under the `/` or `@` that opened it.
  const triggerStart = open ? trigger.start : undefined;
  useLayoutEffect(() => {
    if (triggerStart === undefined || !textarea.current) {
      return;
    }
    const c = caretCoordinates(textarea.current, triggerStart);
    setAnchor({ left: c.left, top: c.top + c.height });
  }, [triggerStart, value.text]);

  // cmdk names its list and items itself; read the ids back for the textarea's combobox attributes.
  const activeValue = active?.key;
  useLayoutEffect(() => {
    const listEl = list.current;
    const next = {
      active:
        listEl?.querySelector<HTMLElement>('[cmdk-item][data-selected="true"]')
          ?.id ?? undefined,
      list: listEl?.id ?? undefined,
    };
    setAria((prev) =>
      prev.list === next.list && prev.active === next.active ? prev : next
    );
  }, [open, activeValue, suggestions.length]);

  const move = (step: number) => {
    if (selectable.length === 0) {
      return;
    }
    const index = active ? selectable.indexOf(active) : -1;
    const next = (index + step + selectable.length) % selectable.length;
    setActiveKey(selectable[next].key);
  };

  const send = () => {
    if (!value.text.trim() || busy || !target.ready) {
      return;
    }
    setBusy(true);
    props
      .onSend({
        mentions: value.mentions,
        text: value.text,
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((a) => ({
                name: a.name,
                url: a.url,
              })),
            }
          : {}),
        ...(sentModel ? { model: sentModel } : {}),
        ...(sentAgent ? { agent: sentAgent } : {}),
      })
      .then(
        (result) => {
          setValue({ mentions: [], text: "" });
          setAttachments([]);
          setCaret(0);
          setError(undefined);
          if (result) {
            props.onSent?.(sentNotice(result));
          }
        },
        (error_: unknown) =>
          setError(error_ instanceof Error ? error_.message : String(error_))
      )
      .finally(() => setBusy(false));
  };

  const interrupt = async () => {
    if (busy || !target.ready) {
      return;
    }
    setBusy(true);
    try {
      const result = await props.onSend({ mentions: [], text: "/interrupt" });
      setError(undefined);
      if (result) {
        props.onSent?.(sentNotice(result));
      }
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_));
    } finally {
      setBusy(false);
    }
  };

  // Send, New line and Stop are rebindable shortcuts scoped to the prompt. They run on the textarea itself, ahead of
  // React's onKeyDown below, so each steps aside while the suggestion list is open and owns Enter, Tab and Escape.
  const listOwnsKeys = open && selectable.length > 0;
  const prompt = {
    ignoreInputs: false,
    preventDefault: false,
    stopPropagation: false,
    target: textarea,
  };
  useShortcut(
    "chatSend",
    (e) => {
      if (e.isComposing || (listOwnsKeys && active)) {
        return;
      }
      e.preventDefault();
      send();
    },
    prompt
  );
  // Shift+Enter inserts a newline natively; another binding has to do it by hand.
  useShortcut(
    "chatNewline",
    (e) => {
      const el = textarea.current;
      if (e.isComposing || !el) {
        return;
      }
      e.preventDefault();
      const start = el.selectionStart;
      const text = `${value.text.slice(0, start)}\n${value.text.slice(el.selectionEnd)}`;
      apply({ caret: start + 1, value: rebase(value, text) });
    },
    prompt
  );
  useShortcut(
    "chatInterrupt",
    (e) => {
      if (open || !running) {
        return;
      }
      e.preventDefault();
      void interrupt();
    },
    prompt
  );
  const sendKeys = useShortcutLabel("chatSend");

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if (e.defaultPrevented) {
      return;
    }
    if (open && selectable.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        move(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && active) {
        e.preventDefault();
        active.choose();
        return;
      }
    }
    if (open && e.key === "Escape") {
      e.preventDefault();
      setDismissed(trigger.start);
      return;
    }
    if (e.key === "Backspace" && el.selectionStart === el.selectionEnd) {
      const out = deleteMentionBefore(value, el.selectionStart);
      if (out) {
        e.preventDefault();
        apply(out);
      }
    }
  };

  const syncCaret = () => setCaret(textarea.current?.selectionStart ?? 0);

  const groups = (["Commands", "Files", "Agents"] as const)
    .map((g) => ({ name: g, items: suggestions.filter((s) => s.group === g) }))
    .filter((g) => g.items.length > 0);
  const loading =
    (trigger?.kind === "command" && commands.isPending) ||
    (trigger?.kind === "mention" && (files.isPending || agents.isPending));
  const failure = commands.error ?? agents.error ?? files.error;

  const canSend = !busy && !!value.text.trim() && target.ready;
  let placeholder = hero
    ? "Describe the task… / for commands, @ for files and agents"
    : "Message the agent… / for commands, @ for files and agents";
  if (!target.ready) {
    placeholder = "Message the agent…";
  } else if (running) {
    placeholder = "Message the agent; it's queued behind the current turn…";
  }

  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <InputGroup
        data-disabled={!target.ready}
        className={cn(
          "bg-card dark:bg-card rounded-xl shadow-sm",
          dragging && "ring-ring/60 ring-2"
        )}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          // Leaving for one of its own children isn't leaving.
          const to = e.relatedTarget;
          if (!(to instanceof Node && e.currentTarget.contains(to))) {
            setDragging(false);
          }
        }}
        onDrop={onDrop}
      >
        {attachments.length > 0 && (
          <InputGroupAddon align="block-start">
            <ul
              aria-label="Attached files"
              className="flex min-w-0 flex-wrap gap-2"
            >
              {attachments.map((a) => (
                <li key={a.id} className="min-w-0">
                  <Attachment size="sm" className="max-w-60 min-w-0">
                    {a.mime.startsWith("image/") ? (
                      <AttachmentMedia variant="image">
                        <img src={a.url} alt="" />
                      </AttachmentMedia>
                    ) : (
                      <AttachmentMedia>
                        <FileIcon aria-hidden />
                      </AttachmentMedia>
                    )}
                    <AttachmentContent>
                      <AttachmentTitle title={a.name}>{a.name}</AttachmentTitle>
                      <AttachmentDescription>
                        {formatSize(a.size)}
                      </AttachmentDescription>
                    </AttachmentContent>
                    <AttachmentActions>
                      <AttachmentAction
                        aria-label={`Remove ${a.name}`}
                        onClick={() =>
                          setAttachments((held) =>
                            held.filter((h) => h.id !== a.id)
                          )
                        }
                      >
                        <XIcon />
                      </AttachmentAction>
                    </AttachmentActions>
                  </Attachment>
                </li>
              ))}
            </ul>
          </InputGroupAddon>
        )}
        <Popover
          open={open}
          onOpenChange={(next) => {
            if (!next && trigger) {
              setDismissed(trigger.start);
            }
          }}
        >
          <div className="relative w-full">
            <label htmlFor="session-prompt" className="sr-only">
              Message the agent
            </label>
            <InputGroupTextarea
              ref={textarea}
              id="session-prompt"
              autoFocus={props.autoFocus}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? aria.list : undefined}
              aria-activedescendant={open ? aria.active : undefined}
              aria-describedby={target.ready ? undefined : "composer-why"}
              disabled={!target.ready}
              placeholder={placeholder}
              className={cn(
                "max-h-[40svh] p-3",
                hero ? "min-h-24 text-base md:text-base" : "min-h-14"
              )}
              value={value.text}
              onChange={(e) => {
                const next = rebase(value, e.target.value);
                setValue(next);
                setCaret(e.target.selectionStart);
                if (!triggerAt(next, e.target.selectionStart)) {
                  setDismissed(undefined);
                }
              }}
              onSelect={syncCaret}
              onClick={syncCaret}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const pasted = filesOf(e.clipboardData);
                if (pasted.length === 0) {
                  return;
                }
                // Copying from some apps carries the text as an image too; paste the text then.
                if (!e.clipboardData.getData("text/plain")) {
                  e.preventDefault();
                  void attach(pasted);
                }
              }}
            />
            <PopoverAnchor asChild>
              <span
                aria-hidden
                className="pointer-events-none absolute size-0"
                style={{ left: anchor.left, top: anchor.top }}
              />
            </PopoverAnchor>
          </div>
          <PopoverContent
            align="start"
            className="w-[min(28rem,calc(100vw-2rem))] p-0"
            onOpenAutoFocus={(e) => e.preventDefault()}
            onCloseAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => {
              if (e.target === textarea.current) {
                e.preventDefault();
              }
            }}
            // Keep the textarea focused when an item is clicked.
            onMouseDown={(e) => e.preventDefault()}
          >
            <Command
              shouldFilter={false}
              value={active?.key ?? ""}
              onValueChange={setActiveKey}
            >
              <CommandList ref={list} aria-label="Suggestions">
                <CommandEmpty>
                  {(() => {
                    if (failure) {
                      return failure.message;
                    }
                    return loading ? "Loading…" : "Nothing matches.";
                  })()}
                </CommandEmpty>
                {groups.map((g) => (
                  <CommandGroup key={g.name} heading={g.name}>
                    {g.items.map((s) => (
                      <CommandItem
                        key={s.key}
                        value={s.key}
                        disabled={s.disabled}
                        onSelect={() => s.choose()}
                      >
                        {g.name === "Commands" && <SquareSlashIcon />}
                        {g.name === "Files" && <FileIcon />}
                        {g.name === "Agents" && <BotIcon />}
                        <span className="flex min-w-0 flex-col">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-mono text-xs">
                              {s.label}
                            </span>
                            {s.note && (
                              <span className="text-muted-foreground bg-muted rounded px-1 text-[0.625rem] uppercase">
                                {s.note}
                              </span>
                            )}
                          </span>
                          {s.description && (
                            <span className="text-muted-foreground truncate text-xs">
                              {s.description}
                            </span>
                          )}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <InputGroupAddon align="block-end" className="min-w-0 gap-1">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void attach([...(e.target.files ?? [])]);
              e.target.value = "";
            }}
          />
          <Tip label="Attach files or images">
            <InputGroupButton
              size="icon-sm"
              variant="outline"
              className="rounded-full"
              aria-label="Attach files or images"
              disabled={!target.ready}
              onClick={() => fileInput.current?.click()}
            >
              <PlusIcon />
            </InputGroupButton>
          </Tip>
          {!target.ready && (
            <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1.5 px-1 text-xs">
              <StatusDot tone={target.tone} />
              <span className="truncate">
                {props.checkoutLabel} · {target.label}
              </span>
              <StartContainer
                projectId={projectId}
                envId={target.envId}
                startable={target.startable}
                starting={target.starting}
              />
            </span>
          )}
          <div className="ml-auto flex min-w-0 items-center gap-0.5">
            <AgentPicker
              agents={models.data?.agents}
              value={shownAgent}
              onChange={setChosenAgent}
              disabled={!target.ready}
            />
            <ModelPicker
              models={models.data}
              value={shownModel}
              onChange={setChosenModel}
              disabled={!target.ready}
            />
            <Tip
              label={`${running ? "Queue behind the current turn" : "Send"}${sendKeys ? ` (${sendKeys})` : ""}`}
            >
              <InputGroupButton
                type="submit"
                size="icon-sm"
                variant="default"
                className="ml-1 rounded-full"
                aria-label={running ? "Queue" : "Send"}
                disabled={!canSend}
              >
                {running ? <ListEndIcon /> : <ArrowUpIcon />}
              </InputGroupButton>
            </Tip>
          </div>
        </InputGroupAddon>
      </InputGroup>
      {props.footer}
      {!target.ready && (
        <p id="composer-why" className="text-muted-foreground text-sm">
          {target.why}
        </p>
      )}
      {error && <p className="text-destructive text-sm">{error}</p>}
    </form>
  );
};
