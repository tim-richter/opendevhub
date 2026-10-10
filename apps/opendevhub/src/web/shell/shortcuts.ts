/**
 * The keyboard shortcuts opendevhub handles, as Settings lists them. Each is bound where it acts (the shell, the
 * sidebar, a dialog or a card); keep this list in step when adding or changing one.
 */

/** `mod` reads as ⌘ on a Mac and Ctrl elsewhere. */
export type ShortcutKey = "mod" | "enter" | "esc" | string;

export interface Shortcut {
  keys: ShortcutKey[];
  /** Another key that does the same, such as `k` beside `j`. */
  alt?: ShortcutKey[];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  /** Where the shortcuts work. */
  hint: string;
  shortcuts: Shortcut[];
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    hint: "Anywhere, while you aren't typing in a field",
    shortcuts: [
      { keys: ["mod", "k"], label: "Open the command palette" },
      { keys: ["n"], label: "New task" },
      { keys: ["mod", "b"], label: "Show or hide the sidebar" },
    ],
    title: "General",
  },
  {
    hint: "In the New task form and a session's prompt",
    shortcuts: [{ keys: ["mod", "enter"], label: "Send" }],
    title: "Writing",
  },
  {
    hint: "On a pending permission or question card",
    shortcuts: [
      { keys: ["enter"], label: "Allow once" },
      { keys: ["a"], label: "Always allow" },
      { keys: ["r"], label: "Reject" },
      { alt: ["k"], keys: ["j"], label: "Next / previous card" },
    ],
    title: "Pending requests",
  },
  {
    hint: "In a review's diff",
    shortcuts: [
      { alt: ["k"], keys: ["j"], label: "Next / previous comment" },
      { keys: ["esc"], label: "Cancel the comment you're writing" },
    ],
    title: "Review",
  },
];

export const isMac = (): boolean =>
  typeof navigator !== "undefined" && /mac/iu.test(navigator.platform);

/** How a key is printed on a keycap. */
export const keyLabel = (key: ShortcutKey, mac = isMac()): string => {
  switch (key) {
    case "mod": {
      return mac ? "⌘" : "Ctrl";
    }
    case "enter": {
      return mac ? "↩" : "Enter";
    }
    case "esc": {
      return "Esc";
    }
    default: {
      return key.length === 1 ? key.toUpperCase() : key;
    }
  }
};
