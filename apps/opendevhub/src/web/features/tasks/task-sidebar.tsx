import { Button } from "@opendevhub/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@opendevhub/ui/popover";
import { useMutation } from "@tanstack/react-query";
import { MessagesSquareIcon, PlusIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { modelShortName } from "../../../shared/tasks";
import type {
  ProjectView,
  SessionSummary,
  TaskView,
  VariantView,
} from "../../../shared/types";
import { taskHref } from "../../../shared/urls";
import type { TaskTab } from "../../../shared/urls";
import { archiveTaskConversation, startTaskConversation } from "../../api";
import { Segmented } from "../../components/page";
import { StatusDot, TONE_TEXT } from "../../components/status";
import type { Tone } from "../../derive";
import { Link, useNavigate, useSearchParams } from "../../routing";
import { resultOf } from "../checks/checks";
import { useVariantStatus } from "./task-status";
import {
  activeVariants,
  formatCost,
  showsVariants,
  startStepLabel,
  taskSessions,
  VARIANT_STATE,
  variantState,
} from "./tasks";

/** The variant's conversations, in the order they were started. */
export const variantThreads = (
  view: ProjectView,
  task: TaskView,
  variant: VariantView
): SessionSummary[] =>
  taskSessions(view, task.id)
    .filter((session) => session.task?.n === variant.n)
    .toSorted((a, b) => a.id.localeCompare(b.id));

/** The conversation the Conversation tab shows: `thread`, else the variant's own, else the newest. */
export const selectedThread = (
  threads: SessionSummary[],
  variant: VariantView,
  thread: string | null | undefined
): SessionSummary | undefined =>
  threads.find((s) => s.id === thread) ??
  threads.find((s) => s.id === variant.sessionId) ??
  threads.at(-1);

/** Selecting a variant keeps the tab and drops the thread, which belongs to the previous variant. */
const variantHref = (
  view: ProjectView,
  task: TaskView,
  current: TaskTab,
  n: number
) =>
  taskHref(view.project.id, task.id, {
    tab: current === "compare" ? "conversation" : current,
    v: n,
  });

const variantSession = (view: ProjectView, v: VariantView) =>
  v.sessionId ? view.sessions.find((s) => s.id === v.sessionId) : undefined;

const Stats = ({
  view,
  variant,
}: {
  view: ProjectView;
  variant: VariantView;
}) => {
  const status = useVariantStatus(view, variant);
  const all = status.checks?.checks ?? [];
  const passed = all.filter(
    (c) => resultOf(status.checks?.run, c)?.status === "passed"
  ).length;
  const checks = all.length > 0 ? `${passed}/${all.length}` : undefined;
  return (
    <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs tabular-nums">
      {status.stats && (
        <span>
          <span className="text-ok">+{status.stats.additions}</span>{" "}
          <span className="text-destructive">−{status.stats.deletions}</span>
        </span>
      )}
      {checks && <span title="Checks passed">checks {checks}</span>}
      <span>{formatCost(variantSession(view, variant)?.cost)}</span>
    </span>
  );
};

/** One active variant: number, model, state (with its setup step while starting), branch, +/−, checks and cost. */
const VariantCard = (props: {
  view: ProjectView;
  task: TaskView;
  variant: VariantView;
  selected: boolean;
  current: TaskTab;
}) => {
  const { view, task, variant: v } = props;
  const state = variantState(v, variantSession(view, v));
  const { label, tone } = VARIANT_STATE[state];
  return (
    <Link
      to={variantHref(view, task, props.current, v.n)}
      aria-current={props.selected ? "true" : undefined}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2 text-sm transition-colors",
        props.selected
          ? "border-foreground/40 bg-accent"
          : "hover:bg-accent/50 border-transparent"
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <strong className="font-semibold">V{v.n}</strong>
        {v.model && <span className="truncate">{modelShortName(v.model)}</span>}
        <span
          className={cn(
            "ml-auto flex shrink-0 items-center gap-1 text-xs",
            TONE_TEXT[tone]
          )}
        >
          <StatusDot tone={tone} label={label} />
          {label}
        </span>
      </span>
      {state === "starting" && (
        <span className="text-muted-foreground text-xs">
          {startStepLabel(v.step)}…
        </span>
      )}
      {state === "failed" && v.error && (
        <span className="text-destructive line-clamp-2 text-xs">{v.error}</span>
      )}
      {v.branch && (
        <span className="text-muted-foreground truncate font-mono text-xs">
          {v.branch}
        </span>
      )}
      {v.directory && <Stats view={view} variant={v} />}
    </Link>
  );
};

/** Start and close the variant's conversations; closing the shown one shows the newest left. */
const useConversations = (props: {
  view: ProjectView;
  task: TaskView;
  variant: VariantView;
  current: TaskTab;
}) => {
  const { view, task, variant } = props;
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const threads = variantThreads(view, task, variant);
  const selected = selectedThread(threads, variant, params.get("thread"));
  const path = (thread?: string) =>
    taskHref(view.project.id, task.id, {
      v: variant.n,
      ...(thread ? { thread } : {}),
    });
  const start = useMutation({
    mutationFn: () => {
      if (!variant.sessionId) {
        throw new Error("The task has no conversation to continue from");
      }
      return startTaskConversation(view.project.id, variant.sessionId);
    },
    onSuccess: (id) => void navigate(path(id)),
  });
  const close = useMutation({
    mutationFn: (id: string) => archiveTaskConversation(view.project.id, id),
    onSuccess: (_result, id) => {
      if (props.current === "conversation" && selected?.id === id) {
        const remaining = threads.filter((s) => s.id !== id);
        void navigate(path(remaining.at(-1)?.id), { replace: true });
      }
    },
  });
  return {
    canStart: !!variant.sessionId && !variant.discarded,
    close,
    error: (start.error ?? close.error)?.message,
    path,
    selected,
    start,
    threads,
  };
};

const SESSION_TONE: Record<SessionSummary["status"], Tone> = {
  idle: "off",
  "needs-answer": "attention",
  "needs-permission": "attention",
  running: "running",
};

const threadLabel = (s: SessionSummary, i: number, count: number) =>
  s.title || (count === 1 ? "Conversation" : `Conversation ${i + 1}`);

/** The selected variant's conversations, the variant's own first; then New conversation. */
const VariantConversations = (props: {
  view: ProjectView;
  task: TaskView;
  variant: VariantView;
  current: TaskTab;
  onNavigate?: () => void;
}) => {
  const c = useConversations(props);
  const shows = showsVariants(props.task);
  const ordered = [
    ...c.threads.filter((s) => s.id === props.variant.sessionId),
    ...c.threads.filter((s) => s.id !== props.variant.sessionId),
  ];
  return (
    <section className="flex min-w-0 flex-col gap-1">
      <h3 className="text-muted-foreground px-1 text-xs font-semibold tracking-wider uppercase">
        {shows ? `Conversations in V${props.variant.n}` : "Conversations"}
      </h3>
      <ul className="flex flex-col">
        {ordered.map((s) => {
          const label = threadLabel(s, c.threads.indexOf(s), c.threads.length);
          const active =
            props.current === "conversation" && c.selected?.id === s.id;
          return (
            <li
              key={s.id}
              className={cn(
                "group flex min-w-0 items-center rounded-md",
                active ? "bg-accent" : "hover:bg-accent/50"
              )}
            >
              <Link
                to={c.path(s.id)}
                aria-current={active ? "page" : undefined}
                onClick={props.onNavigate}
                className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm"
              >
                <StatusDot tone={SESSION_TONE[s.status]} />
                <span className="truncate" title={label}>
                  {label}
                </span>
              </Link>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground size-7 shrink-0 opacity-60 group-hover:opacity-100"
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                disabled={c.close.isPending}
                onClick={() => c.close.mutate(s.id)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </li>
          );
        })}
      </ul>
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-auto flex-wrap justify-start gap-x-1.5 py-1.5 text-left whitespace-normal"
        disabled={!c.canStart || c.start.isPending}
        onClick={() => c.start.mutate()}
        title="Start a conversation with fresh context in this checkout"
      >
        <PlusIcon /> New conversation
        <span className="text-muted-foreground/70 text-xs">
          · fresh context
        </span>
      </Button>
      {c.error && <p className="text-destructive px-1 text-xs">{c.error}</p>}
    </section>
  );
};

const Section = (props: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-1">
    <h3 className="text-muted-foreground px-1 text-xs font-semibold tracking-wider uppercase">
      {props.title}
    </h3>
    {props.children}
  </section>
);

/**
 * The left sidebar from 768px: the variant cards (with two or more active variants) and the selected variant's
 * conversations. From 768px to 1024px it is an icon strip; from 1024px it shows in full.
 */
export const TaskSidebar = (props: {
  view: ProjectView;
  task: TaskView;
  variant: VariantView;
  current: TaskTab;
}) => {
  const { view, task, variant, current } = props;
  const shows = showsVariants(task);
  const variants = activeVariants(task);
  return (
    <>
      <nav
        aria-label="Variants and conversations"
        className="hidden min-h-0 min-w-0 flex-col gap-5 overflow-y-auto lg:flex"
      >
        {shows && (
          <Section title="Variants">
            <div className="flex flex-col gap-1">
              {variants.map((v) => (
                <VariantCard
                  key={v.n}
                  view={view}
                  task={task}
                  variant={v}
                  selected={v.n === variant.n}
                  current={current}
                />
              ))}
            </div>
          </Section>
        )}
        <VariantConversations
          view={view}
          task={task}
          variant={variant}
          current={current}
        />
      </nav>
      <SidebarIcons {...props} />
    </>
  );
};

/** The sidebar's icon form for 768–1023px: variant numbers with state dots, conversations in a popover, New conversation. */
const SidebarIcons = (props: {
  view: ProjectView;
  task: TaskView;
  variant: VariantView;
  current: TaskTab;
}) => {
  const { view, task, variant, current } = props;
  const c = useConversations(props);
  return (
    <nav
      aria-label="Variants and conversations"
      className="hidden flex-col items-center gap-2 md:flex lg:hidden"
    >
      {showsVariants(task) &&
        activeVariants(task).map((v) => {
          const { label, tone } =
            VARIANT_STATE[variantState(v, variantSession(view, v))];
          const selected = v.n === variant.n;
          return (
            <Link
              key={v.n}
              to={variantHref(view, task, current, v.n)}
              aria-current={selected ? "true" : undefined}
              aria-label={`V${v.n}${v.model ? ` · ${modelShortName(v.model)}` : ""}: ${label}`}
              title={`V${v.n}${v.model ? ` · ${modelShortName(v.model)}` : ""} · ${label}`}
              className={cn(
                "relative grid size-10 place-items-center rounded-md border text-sm font-semibold",
                selected
                  ? "border-foreground/40 bg-accent"
                  : "hover:bg-accent/50"
              )}
            >
              V{v.n}
              <StatusDot tone={tone} className="absolute top-1 right-1" />
            </Link>
          );
        })}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="size-10"
            aria-label="Conversations"
            title="Conversations"
          >
            <MessagesSquareIcon />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="right" align="start" className="w-64 p-2">
          <VariantConversations
            view={view}
            task={task}
            variant={variant}
            current={current}
          />
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon"
        className="size-10"
        aria-label="New conversation"
        title="New conversation · fresh context"
        disabled={!c.canStart || c.start.isPending}
        onClick={() => c.start.mutate()}
      >
        <PlusIcon />
      </Button>
    </nav>
  );
};

/** Phones: a V1/V2 segmented control with each variant's state dot, only with two or more active variants. */
export const PhoneVariants = (props: {
  view: ProjectView;
  task: TaskView;
  variant: VariantView;
  current: TaskTab;
}) => {
  const { view, task, variant, current } = props;
  const navigate = useNavigate();
  if (!showsVariants(task)) {
    return null;
  }
  return (
    <div className="md:hidden">
      <Segmented
        label="Variant"
        value={String(variant.n)}
        options={activeVariants(task).map((v) => {
          const { label, tone } =
            VARIANT_STATE[variantState(v, variantSession(view, v))];
          return {
            id: String(v.n),
            label: (
              <span className="flex min-h-9 items-center gap-1.5 px-1">
                <StatusDot tone={tone} label={label} />V{v.n}
              </span>
            ),
          };
        })}
        onChange={(n) =>
          void navigate(variantHref(view, task, current, Number(n)))
        }
      />
    </div>
  );
};

/** Phones, on the Conversation tab: which of the variant's conversations to show. */
export const PhoneThreadSelect = (props: {
  view: ProjectView;
  task: TaskView;
  variant: VariantView;
  current: TaskTab;
}) => {
  const c = useConversations(props);
  const navigate = useNavigate();
  if (c.threads.length === 0) {
    return null;
  }
  const NEW = "__new";
  return (
    <label className="flex min-w-0 items-center gap-2 text-sm md:hidden">
      <span className="text-muted-foreground shrink-0">Conversation</span>
      <select
        className="bg-background border-input min-h-11 min-w-0 flex-1 rounded-md border px-2"
        value={c.selected?.id ?? ""}
        onChange={(e) => {
          if (e.target.value === NEW) {
            c.start.mutate();
          } else {
            void navigate(c.path(e.target.value), { replace: true });
          }
        }}
      >
        {c.threads.map((s, i) => (
          <option key={s.id} value={s.id}>
            {threadLabel(s, i, c.threads.length)}
          </option>
        ))}
        {c.canStart && <option value={NEW}>+ New conversation</option>}
      </select>
    </label>
  );
};
