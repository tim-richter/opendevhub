import { modelShortName } from "../../../shared/tasks";
import type {
  ChecksView,
  ProjectView,
  ReviewData,
  ReviewFile,
  SessionSummary,
  SpecWorkflow,
  StartStep,
  TaskResult,
  TaskView,
  VariantView,
} from "../../../shared/types";
import { chatHref, taskHref } from "../../../shared/urls";
import type { TaskTab } from "../../../shared/urls";
import { workspaceFolderOf } from "../../derive";
import type { Tone } from "../../derive";
import { checksState } from "../checks/checks";

export const taskOf = (view: ProjectView, task: string): TaskView | undefined =>
  view.tasks.find((t) => t.id === task);

/** The task a session belongs to, with the session's variant. */
export const variantOf = (
  view: ProjectView,
  session: SessionSummary
): { task: TaskView; variant: VariantView } | undefined => {
  const ref = session.task;
  const task = ref && taskOf(view, ref.id);
  const variant = task?.variants.find((v) => v.n === ref?.n);
  return task && variant ? { task, variant } : undefined;
};

/** The task's sessions in variant order. Discarded variants' sessions never reach the dashboard. */
export const taskSessions = (
  view: ProjectView,
  task: string
): SessionSummary[] =>
  view.sessions
    .filter((s) => s.task?.id === task)
    .toSorted((a, b) => (a.task?.n ?? 0) - (b.task?.n ?? 0));

/** Variants still being set up, or that failed to and weren't dismissed. */
export const startingVariants = (task: TaskView): VariantView[] =>
  task.variants.filter(
    (v) => !v.discarded && (v.step === "failed" || !v.sessionId)
  );

/** Variants whose session is gone from opencode, picks and discards aside. */
export const endedVariants = (task: TaskView): VariantView[] =>
  task.variants.filter((v) => v.sessionRemoved && !v.discarded);

/** A variant's short name: its model, or its number. */
export const variantName = (session: SessionSummary): string =>
  session.model ? modelShortName(session.model) : `#${session.task?.n ?? 1}`;

export const formatCost = (usd: number | undefined): string => {
  if (usd === undefined) {
    return "—";
  }
  if (usd > 0 && usd < 0.01) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
};

export const formatTokens = (n: number | undefined): string => {
  if (n === undefined) {
    return "—";
  }
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  return `${(n / 1_000_000).toFixed(1)}M`;
};

/** Where to go after starting a task: its page, on the Conversation tab; nowhere if no variant started. */
export const taskDestination = (
  projectId: string,
  result: TaskResult
): string | undefined =>
  result.variants.some((v) => v.sessionId)
    ? taskHref(projectId, result.task)
    : undefined;

/** The variants that failed, as one line for the error banner. */
export const taskFailures = (result: TaskResult): string | undefined => {
  const lines = result.variants.flatMap((v, i) =>
    v.error
      ? [`variant ${i + 1}${v.branch ? ` (${v.branch})` : ""}: ${v.error}`]
      : []
  );
  return lines.length > 0 ? lines.join("; ") : undefined;
};

export const diffStats = (
  data: ReviewData
): {
  files: number;
  additions: number;
  deletions: number;
} => {
  const stats = { additions: 0, deletions: 0, files: 0 };
  for (const f of data.files) {
    stats.additions += f.additions;
    stats.deletions += f.deletions;
    stats.files += 1;
  }
  return stats;
};

export interface Removal {
  name: string;
  /** Undefined when the variant's review didn't load, so it's unknown. */
  dirty?: boolean;
  /** The worktree's branch wasn't created by this task, so only the worktree is removed. */
  branchKept?: true;
}

/** The worktrees "Pick this one" would remove (mirrors the server): other variants' worktrees no remaining session uses. */
export const removals = (
  view: ProjectView,
  task: string,
  keep: string,
  dirty: Record<string, boolean>
): Removal[] => {
  const ws = workspaceFolderOf(view);
  const kept = view.sessions.find((s) => s.id === keep);
  const others = taskSessions(view, task).filter(
    (s) => s.task?.n !== kept?.task?.n
  );
  const branchOf = (s: SessionSummary) => variantOf(view, s)?.variant.branch;
  const inUse = new Set(
    view.sessions.filter((s) => !others.includes(s)).map((s) => s.directory)
  );
  return [...new Set(others.map((s) => s.directory))]
    .filter((d) => d !== ws && !inUse.has(d))
    .flatMap((d) => {
      const worktree = view.runtime.worktrees?.find((w) => w.path === d);
      if (!worktree) {
        return [];
      }
      const ours =
        worktree.branch === undefined ||
        others.some(
          (s) => s.directory === d && branchOf(s) === worktree.branch
        );
      return [
        {
          name: worktree.branch ?? d,
          ...(d in dirty ? { dirty: dirty[d] } : {}),
          ...(ours ? {} : { branchKept: true as const }),
        },
      ];
    });
};

/** The two confirmations of "Pick this one": discard the others, then (optionally) remove their worktrees. */
export const pickPrompts = (
  keepName: string,
  discardCount: number,
  list: Removal[],
  othersRunning = false
): { discard: string; remove?: string } => {
  const one = discardCount === 1;
  const discard = `Keep ${keepName} and discard the other ${one ? "variant" : `${discardCount} variants`}? ${
    one
      ? "It disappears from the dashboard; its conversation stays"
      : "They disappear from the dashboard; their conversations stay"
  } in opencode.${othersRunning ? " Running variants are stopped." : ""}`;
  if (list.length === 0) {
    return { discard };
  }
  const lines = list
    .map((r) => {
      let dirty;
      if (r.dirty === true) {
        dirty = "has uncommitted changes";
      } else if (r.dirty === undefined) {
        dirty = "may have uncommitted changes";
      } else {
        dirty = "";
      }
      const kept = r.branchKept ? "branch kept (not created by this task)" : "";
      const notes = [dirty, kept].filter(Boolean).join(", ");
      return `• ${r.name}${notes ? ` — ${notes}` : ""}`;
    })
    .join("\n");
  return {
    discard,
    remove: `Also remove their worktrees and delete their branches? Uncommitted changes and unmerged commits are lost.\n\n${lines}\n\nCancel keeps them.`,
  };
};

/**
 * The "created by" chip on a conversation row: the task's variant (with its model when there are several) or the AI
 * review it runs, linking to the task page; or for a chat, that it is one (started here or in opencode), linking to
 * its chat view.
 */
export const taskChip = (
  view: ProjectView,
  s: SessionSummary
):
  | { label: string; title: string; to?: string; model?: string }
  | undefined => {
  const found = variantOf(view, s);
  if (!found) {
    const chat = s.chat ? view.chats.find((c) => c.id === s.chat) : undefined;
    if (!chat) {
      return undefined;
    }
    const to = chatHref(view.project.id, chat.id);
    return chat.origin === "opencode"
      ? {
          label: "started in opencode",
          title: "Found in opencode; started outside opendevhub",
          to,
        }
      : { label: "chat", title: `Chat: ${chat.title}`, to };
  }
  const { task, variant } = found;
  const to = taskPath(view.project.id, task.id);
  if (task.kind === "review") {
    return { label: "AI review", title: task.title, to };
  }
  const title = `Task: ${task.title}`;
  const of = task.variants.length;
  if (of === 1) {
    return { label: "task", title, to };
  }
  return {
    label: `task ${variant.n}/${of}`,
    title,
    to,
    ...(s.model ? { model: modelShortName(s.model) } : {}),
  };
};

export const projectIdFromPath = (pathname: string): string | undefined => {
  const m = pathname.match(/^\/p\/(?<g1>[^/]+)/u);
  return m ? decodeURIComponent(m[1]) : undefined;
};

/** `<select>` values for models; "" is the project's default. Model ids can contain "/", so encode as JSON. */
export const modelKey = (
  ref: { id: string; providerID: string } | undefined
): string => (ref ? JSON.stringify([ref.providerID, ref.id]) : "");

export const modelFromKey = (
  key: string
): { id: string; providerID: string } | undefined => {
  if (!key) {
    return undefined;
  }
  const [providerID, id] = JSON.parse(key) as [string, string];
  return { id, providerID };
};

const STEP_LABELS: Record<StartStep, string> = {
  approval: "Needs approval",
  container: "Starting the container",
  failed: "Failed",
  image: "Preparing the image",
  pushing: "Pushing the base",
  queued: "Waiting",
  session: "Starting the conversation",
  worktree: "Creating the worktree",
};

/** What a starting variant is doing, for its card. */
export const startStepLabel = (step: StartStep): string => STEP_LABELS[step];

/** A task's page: its variants, and while they're set up, their progress. */
export const taskPath = (projectId: string, task: string): string =>
  taskHref(projectId, task);

export interface FileCell {
  status: ReviewFile["status"];
  additions: number;
  deletions: number;
}

export interface FileRow {
  file: string;
  /** One per variant, in order; undefined when that variant leaves the file alone. */
  cells: (FileCell | undefined)[];
  /** Every variant changes the file the same way (by line counts). */
  same: boolean;
}

/** The files the variants touch, side by side: files they disagree on first, then by path. */
export const fileMatrix = (
  reviews: readonly (ReviewData | null | undefined)[]
): FileRow[] => {
  const files = new Set<string>();
  for (const r of reviews) {
    for (const f of r?.files ?? []) {
      files.add(f.file);
    }
  }
  const rows = [...files].map((file): FileRow => {
    const cells = reviews.map((r) => {
      const f = r?.files.find((x) => x.file === file);
      return f
        ? { additions: f.additions, deletions: f.deletions, status: f.status }
        : undefined;
    });
    const key = (c: FileCell | undefined) =>
      c ? `${c.status}:${c.additions}:${c.deletions}` : "-";
    return {
      cells,
      file,
      same: cells.every((c) => key(c) === key(cells[0])),
    };
  });
  return rows.toSorted(
    (a, b) => Number(a.same) - Number(b.same) || a.file.localeCompare(b.file)
  );
};

/** Why a spec-first task can't start in this environment; undefined when it can. */
export const specUnavailable = (spec: SpecWorkflow): string | undefined => {
  if (spec.missing.length > 0) {
    return `opencode lacks ${spec.missing.join(", ")}; run \`openspec update\` in the repository.`;
  }
  if (spec.cli === false) {
    return "The container has no openspec CLI; add it to the devcontainer.";
  }
  return undefined;
};

/** A variant's state for the hub's rows: discarded, failed, still starting, ended, or its live session's status. */
export const variantStatus = (
  v: VariantView,
  session: SessionSummary | undefined
): { label: string; tone: Tone } => {
  if (v.discarded) {
    return { label: "discarded", tone: "off" };
  }
  if (v.step === "failed") {
    return { label: "failed", tone: "error" };
  }
  if (!v.sessionId) {
    return { label: startStepLabel(v.step), tone: "running" };
  }
  if (v.sessionRemoved || !session) {
    return { label: v.picked ? "picked · ended" : "ended", tone: "off" };
  }
  const picked = v.picked ? "picked · " : "";
  if (session.status === "running") {
    return { label: `${picked}working`, tone: "running" };
  }
  if (session.status === "idle") {
    return { label: `${picked}idle`, tone: "ok" };
  }
  return { label: `${picked}needs you`, tone: "attention" };
};

/** The variant a task page shows without `?v=`: the picked one, else the first not discarded, else the first. */
export const defaultVariant = (task: TaskView): VariantView | undefined =>
  task.variants.find((v) => v.picked) ??
  task.variants.find((v) => !v.discarded) ??
  task.variants[0];

/** The variant `?v=` names, or the default one when it names none of the task's. */
export const selectedVariant = (
  task: TaskView,
  v: string | null | undefined
): VariantView | undefined =>
  (v ? task.variants.find((x) => String(x.n) === v) : undefined) ??
  defaultVariant(task);

/** The variants not discarded: starting, running, idle, or failed and not yet dismissed. */
export const activeVariants = (task: TaskView): VariantView[] =>
  task.variants.filter((v) => !v.discarded);

/** Two or more active variants: only then does the page tell variants apart (cards, switcher, Compare, "V2" labels). */
export const showsVariants = (task: TaskView): boolean =>
  activeVariants(task).length >= 2;

/** The variants the switcher offers: the active ones, plus the selected one if it was discarded. */
export const switchableVariants = (
  task: TaskView,
  selected: VariantView | undefined
): VariantView[] => {
  const active = activeVariants(task);
  return selected?.discarded
    ? task.variants.filter((v) => active.includes(v) || v.n === selected.n)
    : active;
};

/** A task with several live variants to choose between and compare. */
export const comparesVariants = (task: TaskView): boolean =>
  task.kind === "task" && showsVariants(task);

export type VariantState =
  | "working"
  | "needs-you"
  | "idle"
  | "starting"
  | "failed";

export const VARIANT_STATE: Record<
  VariantState,
  { label: string; tone: Tone }
> = {
  failed: { label: "Failed", tone: "error" },
  idle: { label: "Idle", tone: "ok" },
  "needs-you": { label: "Needs you", tone: "attention" },
  starting: { label: "Starting", tone: "running" },
  working: { label: "Working", tone: "running" },
};

/** A variant's state for its card: failed or starting while set up, else its session's; an ended one is idle. */
export const variantState = (
  v: VariantView,
  session: SessionSummary | undefined
): VariantState => {
  if (v.step === "failed") {
    return "failed";
  }
  if (!v.sessionId) {
    return "starting";
  }
  if (v.sessionRemoved || !session || session.status === "idle") {
    return "idle";
  }
  return session.status === "running" ? "working" : "needs-you";
};

export type TaskAttention = VariantState | "ended";

/** The header's one pill: Needs you, else Working, else Starting, else Ended for an ended task, else Idle. */
export const taskAttention = (
  task: TaskView,
  sessions: readonly SessionSummary[]
): TaskAttention => {
  const states = new Set(
    activeVariants(task).map((v) =>
      variantState(
        v,
        sessions.find((s) => s.id === v.sessionId)
      )
    )
  );
  for (const state of ["needs-you", "working", "starting"] as const) {
    if (states.has(state)) {
      return state;
    }
  }
  return task.state === "ended" ? "ended" : "idle";
};

export const ATTENTION: Record<TaskAttention, { label: string; tone: Tone }> = {
  ...VARIANT_STATE,
  ended: { label: "Ended", tone: "off" },
};

export type TaskStepId =
  | "brief"
  | "agents"
  | "pick"
  | "review"
  | "publish"
  | "pull";

export interface TaskStep {
  id: TaskStepId;
  label: string;
  state: "done" | "current" | "todo";
}

/**
 * The task's progress, worked out from the task, the selected variant and its checkout. `review` and `checks` are
 * undefined while they load (or null when they couldn't be read), which counts as not done. An AI review task has
 * no steps. The first step not done is current; the ones after it are still to do.
 */
export const taskSteps = (
  task: TaskView,
  variant: VariantView | undefined,
  input: {
    sessions: readonly SessionSummary[];
    review?: ReviewData | null;
    checks?: ChecksView | null;
    aiReviewRunning?: boolean;
  }
): TaskStep[] => {
  if (task.kind !== "task") {
    return [];
  }
  const active = activeVariants(task);
  const agentsBusy = active.some((v) => {
    const state = variantState(
      v,
      input.sessions.find((s) => s.id === v.sessionId)
    );
    return state === "working" || state === "needs-you" || state === "starting";
  });
  const { review, checks } = input;
  const checksOk = !!checks && ["none", "passed"].includes(checksState(checks));
  const steps: { id: TaskStepId; label: string; done: boolean }[] = [
    { done: task.state !== "draft", id: "brief", label: "Brief" },
    {
      done: !agentsBusy,
      id: "agents",
      label: active.length >= 2 ? `Agents · ${active.length}` : "Agents",
    },
    ...(task.variants.length >= 2
      ? [
          {
            done: task.variants.some((v) => v.picked),
            id: "pick" as const,
            label: "Pick variant",
          },
        ]
      : []),
    {
      done: checksOk && !!review && !review.dirty && !input.aiReviewRunning,
      id: "review",
      label: "Review & checks",
    },
    { done: !!review?.pushed, id: "publish", label: "Publish" },
    {
      done:
        !!variant &&
        (task.pullRequests ?? []).some((p) => p.variant === variant.n),
      id: "pull",
      label: "Pull request",
    },
  ];
  const current = steps.findIndex((s) => !s.done);
  return steps.map((s, i) => {
    let state: TaskStep["state"] = "todo";
    if (current === -1 || i < current) {
      state = "done";
    } else if (i === current) {
      state = "current";
    }
    return { id: s.id, label: s.label, state };
  });
};

/** A spec-first task, or one implementing a change: it gets a Spec tab. */
export const hasSpec = (task: TaskView): boolean =>
  !!task.spec || task.variants.some((v) => v.spec);

/** The tabs of a task page, in order. */
export const taskTabs = (task: TaskView): TaskTab[] => [
  "conversation",
  "terminal",
  "runtime",
  ...(hasSpec(task) ? (["spec"] as const) : []),
  // Listed in the tab bar only on phones; the rail and strip show checks wider up.
  "checks",
  // Opened from the header's Compare variants, not the tab bar.
  ...(comparesVariants(task) ? (["compare"] as const) : []),
];

/**
 * The conversations of a variant's checkout: every session in the same directory and environment, the variant's own
 * first, then the others newest first.
 */
export const conversationThreads = (
  view: ProjectView,
  variant: VariantView
): SessionSummary[] => {
  const own = variant.sessionId
    ? view.sessions.find((s) => s.id === variant.sessionId)
    : undefined;
  const directory = own?.directory ?? variant.directory;
  if (!directory) {
    return [];
  }
  // A variant names the main environment by the project's id; sessions leave it out.
  const env =
    own?.envId ??
    (variant.envId === view.project.id ? undefined : variant.envId);
  const others = view.sessions
    .filter(
      (s) => s.id !== own?.id && s.directory === directory && s.envId === env
    )
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  return own ? [own, ...others] : others;
};
