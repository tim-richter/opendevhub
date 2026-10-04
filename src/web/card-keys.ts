/**
 * A card ignores its shortcut keys for this long after it appears, so a second Enter (a double press or
 * key repeat) meant for the card just answered can't approve the next one before the user has seen it.
 */
export const ARM_DELAY_MS = 400;

export type CardAction = "once" | "always" | "reject" | "next" | "prev";

export interface CardKey {
  key: string;
  repeat: boolean;
  /** The card itself has focus, not one of its fields. */
  onCard: boolean;
  /** Ctrl, Alt or Meta is held. */
  modified: boolean;
}

const ACTIONS: Record<string, CardAction> = { Enter: "once", a: "always", r: "reject", j: "next", k: "prev" };

/** Which action a keydown on a pending card triggers, if any. */
export function cardAction(k: CardKey, mountedAt: number, now: number): CardAction | undefined {
  if (!k.onCard || k.modified || k.repeat || now - mountedAt < ARM_DELAY_MS) return undefined;
  return ACTIONS[k.key];
}

/** A card that appears after the previous one was answered may only take focus from nowhere or from its own stack. */
export function canTakeFocus<T>(active: T | null, body: T, stack: { contains(node: T): boolean } | null): boolean {
  return active === null || active === body || (stack?.contains(active) ?? false);
}
