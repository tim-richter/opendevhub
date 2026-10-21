import { jiraTicketUrl } from "../../shared/jira";
import type { SpecPhase, VariantView } from "../../shared/types";
import type { TaskRecord } from "../db/tasks";
import type { ExecTarget } from "../environments/containers";
import type { GitPort } from "../environments/ports";

/** The instruction entry a conversation started in a task gets its briefing under. */
export const BRIEFING_KEY = "opendevhub-task";

const MAX_COMMITS = 30;
const MAX_DIFFSTAT_FILES = 40;
const MAX_STATUS_LINES = 40;
const MAX_TASKS_BYTES = 512 * 1024;
const CHECKED = /^\s*[-*]\s+\[[xX]\]/u;
const UNCHECKED = /^\s*[-*]\s+\[ \]/u;

const PHASES: Record<SpecPhase, string> = {
  archived: "archived",
  implement: "implementing",
  propose: "proposing",
};

/** What a briefing says; a section whose field is missing is left out. */
export interface BriefingInput {
  title: string;
  brief?: string;
  ticket?: { key: string; title?: string; url?: string };
  branch?: string;
  base?: string;
  directory: string;
  /** `<short sha> <subject>` per commit since the base, newest first. */
  commits?: string[];
  /** `git diff --stat` against the base: a line per file, then the summary. */
  diffstat?: string[];
  /** `git status --short` lines. */
  status?: string[];
  spec?: {
    phase: SpecPhase;
    change?: string;
    /** The change's folder in the checkout, ending in `/`. */
    folder?: string;
    tasks?: { done: number; total: number };
  };
  /** The titles of the variant's earlier conversations, oldest first. */
  earlier?: string[];
}

const more = (left: number): string[] =>
  left > 0 ? [`… and ${left} more`] : [];

const fenced = (lines: string[]): string => ["```", ...lines, "```"].join("\n");

const commitsSection = (commits: string[]): string => {
  if (commits.length === 0) {
    return "None yet.";
  }
  const shown = commits.slice(0, MAX_COMMITS).map((c) => `- ${c}`);
  return [...shown, ...more(commits.length - MAX_COMMITS)].join("\n");
};

const diffstatSection = (diffstat: string[]): string => {
  if (diffstat.length === 0) {
    return "None: the branch matches its base.";
  }
  const files = diffstat.slice(0, -1);
  const summary = diffstat.at(-1) ?? "";
  return fenced([
    ...files.slice(0, MAX_DIFFSTAT_FILES),
    ...more(files.length - MAX_DIFFSTAT_FILES),
    summary,
  ]);
};

const statusSection = (status: string[]): string =>
  status.length === 0
    ? "None: the working tree is clean."
    : fenced([
        ...status.slice(0, MAX_STATUS_LINES),
        ...more(status.length - MAX_STATUS_LINES),
      ]);

const ticketLine = (ticket: NonNullable<BriefingInput["ticket"]>): string => {
  const summary = ticket.title ? ` — ${ticket.title}` : "";
  const link = ticket.url ? ` (${ticket.url})` : "";
  return `Ticket: ${ticket.key}${summary}${link}`;
};

const specSection = (spec: NonNullable<BriefingInput["spec"]>): string =>
  [
    ...(spec.change ? [`- Change: \`${spec.change}\``] : []),
    `- Phase: ${PHASES[spec.phase]}`,
    ...(spec.tasks
      ? [`- Tasks: ${spec.tasks.done}/${spec.tasks.total} done`]
      : []),
    ...(spec.folder ? [`- Folder: \`${spec.folder}\``] : []),
  ].join("\n");

/** The markdown a conversation started in an existing task is given about it. */
export const buildBriefing = (input: BriefingInput): string => {
  const sections: string[] = [
    "# Task briefing",
    "You are starting a fresh conversation in an ongoing task; earlier conversations in it did not carry over. This briefing describes the task as it stands now. The branch's git history and, for a spec-first task, its OpenSpec change folder are the record of earlier work: read them when you need more.",
  ];
  const task = [`**${input.title}**`];
  if (input.brief?.trim()) {
    task.push(input.brief.trim());
  }
  if (input.ticket) {
    task.push(ticketLine(input.ticket));
  }
  sections.push(
    `## Task\n\n${task.join("\n\n")}`,
    `## Checkout\n\n${[
      ...(input.branch ? [`- Branch: \`${input.branch}\``] : []),
      ...(input.base ? [`- Base: \`${input.base}\``] : []),
      `- Path: \`${input.directory}\``,
    ].join("\n")}`
  );
  if (input.commits) {
    sections.push(
      `## Commits since the base\n\n${commitsSection(input.commits)}`
    );
  }
  if (input.diffstat) {
    sections.push(
      `## Changes against the base\n\n${diffstatSection(input.diffstat)}`
    );
  }
  if (input.status) {
    sections.push(`## Uncommitted changes\n\n${statusSection(input.status)}`);
  }
  if (input.spec) {
    sections.push(`## OpenSpec change\n\n${specSection(input.spec)}`);
  }
  if (input.earlier && input.earlier.length > 0) {
    sections.push(
      `## Earlier conversations\n\n${input.earlier.map((t, i) => `${i + 1}. ${t}`).join("\n")}`
    );
  }
  return `${sections.join("\n\n")}\n`;
};

/** Checked and total items of a `tasks.md`. */
export const taskProgress = (
  markdown: string
): { done: number; total: number } => {
  let done = 0;
  let total = 0;
  for (const line of markdown.split("\n")) {
    if (CHECKED.test(line)) {
      done += 1;
      total += 1;
    } else if (UNCHECKED.test(line)) {
      total += 1;
    }
  }
  return { done, total };
};

/** The checkout folder of a variant's OpenSpec change, when it knows the change. */
const changeFolder = (spec: VariantView["spec"]): string | undefined => {
  if (spec?.archived) {
    return `openspec/changes/archive/${spec.archived}/`;
  }
  return spec?.change ? `openspec/changes/${spec.change}/` : undefined;
};

export interface BriefingSources {
  git: Pick<
    GitPort,
    | "currentBranch"
    | "recordedBase"
    | "mergeBase"
    | "commitsSince"
    | "diffStat"
    | "statusLines"
    | "fileBytes"
  >;
  /** Where git runs for the variant's checkout. */
  target: ExecTarget;
  task: TaskRecord;
  variant: VariantView & { directory: string };
  /** The titles of the variant's earlier conversations, oldest first. */
  earlier: string[];
  /** Told about each step that failed; its section is left out. */
  onError?: (step: string, error: unknown) => void;
}

/** Reads what `buildBriefing` needs; each step that fails leaves its part out. */
export const gatherBriefing = async (
  src: BriefingSources
): Promise<BriefingInput> => {
  const { git, target, task, variant } = src;
  const { directory } = variant;
  const step = async <T>(
    name: string,
    run: () => Promise<T>
  ): Promise<T | undefined> => {
    try {
      return await run();
    } catch (error) {
      src.onError?.(name, error);
      return undefined;
    }
  };
  const branch =
    variant.branch ??
    (await step("branch", () => git.currentBranch(target, directory)));
  const base =
    branch &&
    (await step("base", () => git.recordedBase(target, directory, branch)));
  const forkPoint =
    base &&
    (await step("merge-base", () => git.mergeBase(target, directory, base)));
  const folder = changeFolder(variant.spec);
  const [commits, diffstat, status, tasks] = await Promise.all([
    forkPoint
      ? step("log", () => git.commitsSince(target, directory, forkPoint))
      : undefined,
    forkPoint
      ? step("diffstat", () => git.diffStat(target, directory, forkPoint))
      : undefined,
    step("status", () => git.statusLines(target, directory)),
    folder
      ? step("tasks", () =>
          git.fileBytes(target, directory, `${folder}tasks.md`, {
            maxBytes: MAX_TASKS_BYTES,
          })
        )
      : undefined,
  ]);
  const brief = task.brief ?? task.prompt;
  const ticket = task.ticket ?? task.jira;
  const ticketUrl =
    task.ticket?.url ?? (task.jira ? jiraTicketUrl(task.jira) : undefined);
  return {
    directory,
    title: task.title,
    ...(brief ? { brief } : {}),
    ...(ticket
      ? {
          ticket: {
            key: ticket.key,
            ...(ticket.title ? { title: ticket.title } : {}),
            ...(ticketUrl ? { url: ticketUrl } : {}),
          },
        }
      : {}),
    ...(branch ? { branch } : {}),
    ...(base ? { base } : {}),
    ...(commits ? { commits } : {}),
    ...(diffstat ? { diffstat } : {}),
    ...(status ? { status } : {}),
    ...(variant.spec
      ? {
          spec: {
            phase: variant.spec.phase,
            ...(variant.spec.change ? { change: variant.spec.change } : {}),
            ...(folder ? { folder } : {}),
            ...(tasks ? { tasks: taskProgress(tasks.toString("utf-8")) } : {}),
          },
        }
      : {}),
    ...(src.earlier.length > 0 ? { earlier: src.earlier } : {}),
  };
};
