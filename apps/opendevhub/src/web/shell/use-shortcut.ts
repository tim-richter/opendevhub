import {
  formatForDisplay,
  matchesKeyboardEvent,
  useHotkey,
} from "@tanstack/react-hotkeys";
import type { HotkeyCallback, UseHotkeyOptions } from "@tanstack/react-hotkeys";
import { useSyncExternalStore } from "react";

import {
  bindingOf,
  defaultBinding,
  parseOverrides,
  withBinding,
} from "./shortcuts";
import type { Binding, ShortcutId, ShortcutOverrides } from "./shortcuts";

/** The user's rebound shortcuts live in this browser only, like the rest of opendevhub's view preferences. */
const STORAGE_KEY = "opendevhub.shortcuts";

const listeners = new Set<() => void>();

const read = (): ShortcutOverrides => {
  try {
    return parseOverrides(localStorage.getItem(STORAGE_KEY));
  } catch {
    return {};
  }
};

let current: ShortcutOverrides = read();

const notify = () => {
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Another tab rebinding a shortcut applies here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      current = read();
      notify();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
};

const write = (next: ShortcutOverrides) => {
  current = next;
  try {
    if (Object.keys(next).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    }
  } catch {
    // Storage can be unavailable (private mode); the change still holds for this page.
  }
  notify();
};

export const useShortcutOverrides = (): ShortcutOverrides =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => current
  );

export const useBinding = (id: ShortcutId): Binding =>
  bindingOf(id, useShortcutOverrides());

/** How `id`'s binding reads in a hint, such as "⌘ ↵" or "Ctrl+Enter"; `undefined` when it is turned off. */
export const useShortcutLabel = (id: ShortcutId): string | undefined => {
  const binding = useBinding(id);
  return binding === null ? undefined : formatForDisplay(binding);
};

/** Whether `event` presses `id`'s current binding, for handlers outside React such as the terminal's. */
export const isShortcutEvent = (id: ShortcutId, event: KeyboardEvent) => {
  const binding = bindingOf(id, current);
  return binding !== null && matchesKeyboardEvent(event, binding);
};

/** Rebinds `id`; `null` turns it off. */
export const setBinding = (id: ShortcutId, binding: Binding) =>
  write(withBinding(current, id, binding));

export const resetBinding = (id: ShortcutId) =>
  setBinding(id, defaultBinding(id));

export const resetAllBindings = () => write({});

/**
 * Registers the user's binding for `id` with TanStack Hotkeys. Without a `target` it listens on the document;
 * pass the element a component-level shortcut belongs to. A shortcut the user turned off stays registered but
 * disabled, so hook order never changes.
 */
export const useShortcut = (
  id: ShortcutId,
  callback: HotkeyCallback,
  options: UseHotkeyOptions = {}
) => {
  const binding = useBinding(id);
  useHotkey(binding ?? defaultBinding(id), callback, {
    // Settings keeps bindings in a scope apart, so overlapping registrations here are intended (several cards).
    conflictBehavior: "allow",
    ...options,
    enabled: binding !== null && (options.enabled ?? true),
    meta: { name: id },
  });
};
