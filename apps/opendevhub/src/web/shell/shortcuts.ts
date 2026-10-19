/**
 * The keyboard shortcuts opendevhub handles, as Settings lists them. Each is bound with `useShortcut` where it
 * acts (the shell, the sidebar, a dialog or a card) and can be rebound in Settings; add new ones here.
 */
import { normalizeHotkey } from "@tanstack/react-hotkeys";
import type { HotkeyChord } from "@tanstack/react-hotkeys";

/** Where a shortcut works. Shortcuts only clash with others in their own scope or with a global one. */
export type ShortcutScope =
  | "global"
  | "chat"
  | "conversation"
  | "newTask"
  | "pending"
  | "review";

export interface ShortcutGroup {
  scope: ShortcutScope;
  title: string;
  /** Where the shortcuts work. */
  hint: string;
  shortcuts: { id: ShortcutId; label: string; default: HotkeyChord }[];
}

export const SHORTCUT_GROUPS = [
  {
    hint: "Anywhere; single keys are ignored while you type in a field",
    scope: "global",
    shortcuts: [
      { default: "Mod+K", id: "palette", label: "Open the command palette" },
      { default: "N", id: "newTask", label: "New task" },
      { default: "Mod+B", id: "sidebar", label: "Show or hide the sidebar" },
    ],
    title: "General",
  },
  {
    hint: "In a conversation's prompt; Shift+Enter always adds a new line",
    scope: "chat",
    shortcuts: [
      { default: "Enter", id: "chatSend", label: "Send" },
      { default: "Mod+Enter", id: "chatNewline", label: "New line" },
      { default: "Escape", id: "chatInterrupt", label: "Stop the agent" },
    ],
    title: "Chat",
  },
  {
    hint: "In a conversation whose right sidebar offers the panel; works in the terminal too",
    scope: "conversation",
    shortcuts: [
      {
        default: "Mod+Shift+G",
        id: "panelChanges",
        label: "Show or hide Changes",
      },
      {
        default: "Control+`",
        id: "panelTerminal",
        label: "Show or hide the terminal",
      },
    ],
    title: "Conversation",
  },
  {
    hint: "In the New task form's prompt",
    scope: "newTask",
    shortcuts: [{ default: "Mod+Enter", id: "newTaskStart", label: "Start" }],
    title: "New task",
  },
  {
    hint: "On a pending permission or question card",
    scope: "pending",
    shortcuts: [
      { default: "Enter", id: "cardOnce", label: "Allow once / answer" },
      { default: "A", id: "cardAlways", label: "Always allow" },
      { default: "R", id: "cardReject", label: "Reject" },
      { default: "J", id: "cardNext", label: "Next card" },
      { default: "K", id: "cardPrev", label: "Previous card" },
    ],
    title: "Pending requests",
  },
  {
    hint: "In a review's diff",
    scope: "review",
    shortcuts: [
      { default: "J", id: "reviewNext", label: "Next comment" },
      { default: "K", id: "reviewPrev", label: "Previous comment" },
      {
        default: "Escape",
        id: "reviewCancel",
        label: "Cancel the comment you're writing",
      },
    ],
    title: "Review",
  },
] as const satisfies readonly (Omit<ShortcutGroup, "shortcuts"> & {
  shortcuts: readonly { id: string; label: string; default: HotkeyChord }[];
})[];

export type ShortcutId =
  (typeof SHORTCUT_GROUPS)[number]["shortcuts"][number]["id"];

/** A shortcut's key, or `null` once the user has turned it off. */
export type Binding = HotkeyChord | null;

/** What the user changed; shortcuts left out keep their default. */
export type ShortcutOverrides = Partial<Record<ShortcutId, Binding>>;

const SCOPE_OF = new Map<ShortcutId, ShortcutScope>(
  SHORTCUT_GROUPS.flatMap((g) => g.shortcuts.map((s) => [s.id, g.scope]))
);

const DEFAULTS = new Map<ShortcutId, HotkeyChord>(
  SHORTCUT_GROUPS.flatMap((g) => g.shortcuts.map((s) => [s.id, s.default]))
);

const LABELS = new Map<ShortcutId, string>(
  SHORTCUT_GROUPS.flatMap((g) => g.shortcuts.map((s) => [s.id, s.label]))
);

export const isShortcutId = (id: string): id is ShortcutId =>
  DEFAULTS.has(id as ShortcutId);

export const defaultBinding = (id: ShortcutId): HotkeyChord =>
  DEFAULTS.get(id) as HotkeyChord;

export const bindingOf = (
  id: ShortcutId,
  overrides: ShortcutOverrides
): Binding => (id in overrides ? (overrides[id] ?? null) : defaultBinding(id));

/** Drops anything stored that isn't a known shortcut with a string or `null` binding. */
export const parseOverrides = (raw: string | null): ShortcutOverrides => {
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const out: ShortcutOverrides = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (isShortcutId(id) && (value === null || typeof value === "string")) {
        out[id] = value as Binding;
      }
    }
    return out;
  } catch {
    return {};
  }
};

/** Sets `id` to `binding`, dropping the override when it matches the default. */
export const withBinding = (
  overrides: ShortcutOverrides,
  id: ShortcutId,
  binding: Binding
): ShortcutOverrides => {
  const { [id]: _, ...rest } = overrides;
  return binding !== null && sameHotkey(binding, defaultBinding(id))
    ? rest
    : { ...rest, [id]: binding };
};

const sameHotkey = (a: HotkeyChord, b: HotkeyChord): boolean =>
  normalizeHotkey(a) === normalizeHotkey(b);

const scopesClash = (a: ShortcutScope, b: ShortcutScope): boolean =>
  a === b || a === "global" || b === "global";

/** The label of another shortcut `hotkey` would clash with if `id` took it. */
export const conflictFor = (
  id: ShortcutId,
  hotkey: HotkeyChord,
  overrides: ShortcutOverrides
): string | undefined => {
  const scope = SCOPE_OF.get(id) as ShortcutScope;
  for (const [other, otherScope] of SCOPE_OF) {
    const binding = bindingOf(other, overrides);
    if (
      other !== id &&
      binding !== null &&
      scopesClash(scope, otherScope) &&
      sameHotkey(binding, hotkey)
    ) {
      return LABELS.get(other);
    }
  }
  return undefined;
};
