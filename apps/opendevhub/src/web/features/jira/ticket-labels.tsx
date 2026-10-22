import { Avatar, AvatarFallback } from "@opendevhub/ui/avatar";

import { cn } from "@/lib/utils";

import { JIRA_EPIC_COLORS } from "../../../shared/jira";
import type { JiraEpic } from "../../../shared/jira";

/** Close to Jira's own epic colours, `ghx-label-1` to `ghx-label-14`, in the same order. */
const TONES = [
  "bg-amber-800/15 text-amber-900 ring-amber-800/30 dark:text-amber-200",
  "bg-orange-500/15 text-orange-800 ring-orange-500/30 dark:text-orange-200",
  "bg-yellow-500/20 text-yellow-800 ring-yellow-500/35 dark:text-yellow-200",
  "bg-blue-500/15 text-blue-800 ring-blue-500/30 dark:text-blue-200",
  "bg-slate-500/15 text-slate-800 ring-slate-500/30 dark:text-slate-200",
  "bg-lime-500/20 text-lime-800 ring-lime-500/35 dark:text-lime-200",
  "bg-purple-500/15 text-purple-800 ring-purple-500/30 dark:text-purple-200",
  "bg-violet-500/15 text-violet-800 ring-violet-500/30 dark:text-violet-200",
  "bg-pink-500/15 text-pink-800 ring-pink-500/30 dark:text-pink-200",
  "bg-sky-500/15 text-sky-800 ring-sky-500/30 dark:text-sky-200",
  "bg-teal-500/15 text-teal-800 ring-teal-500/30 dark:text-teal-200",
  "bg-stone-500/15 text-stone-800 ring-stone-500/30 dark:text-stone-200",
  "bg-emerald-500/15 text-emerald-800 ring-emerald-500/30 dark:text-emerald-200",
  "bg-rose-500/15 text-rose-800 ring-rose-500/30 dark:text-rose-200",
] as const;

/** A stable colour for a value, so the same epic or person always looks the same. */
const hashTone = (value: string): number => {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 1_000_003;
  }
  return (hash % JIRA_EPIC_COLORS) + 1;
};

const tone = (color: number) => TONES[color - 1] ?? TONES[0];

/** The epic as a coloured label, in its Jira colour or one derived from its key. */
export const EpicBadge = (props: { epic: JiraEpic; className?: string }) => {
  const { epic } = props;
  return (
    <span
      title={`Epic ${epic.key}: ${epic.name}`}
      className={cn(
        "inline-flex max-w-full min-w-0 items-center rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        tone(epic.color ?? hashTone(epic.key)),
        props.className
      )}
    >
      <span className="truncate">{epic.name}</span>
    </span>
  );
};

const initials = (name: string): string => {
  const words = name.trim().split(/\s+/u);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "?";
};

/** The assignee's initials and name, or a muted "Unassigned". */
export const Assignee = (props: { name?: string; className?: string }) => {
  const { name } = props;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs",
        name ? "text-foreground font-medium" : "text-muted-foreground",
        props.className
      )}
    >
      <Avatar size="sm" className="size-5" aria-hidden>
        <AvatarFallback
          className={cn(
            "text-[0.625rem] font-semibold",
            name
              ? cn("ring-1 ring-inset", tone(hashTone(name)))
              : "border-muted-foreground/40 border border-dashed bg-transparent"
          )}
        >
          {name ? initials(name) : ""}
        </AvatarFallback>
      </Avatar>
      <span className="truncate">{name ?? "Unassigned"}</span>
    </span>
  );
};
