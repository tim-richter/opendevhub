import { diffForNotifications } from "../../shared/notices";
import type { Notice } from "../../shared/notices";
import type { StateStore } from "../projects/state";

/**
 * Diffs each store change against the previous snapshot and hands every new notice to `push.send`.
 * What is already waiting when it starts isn't notified. Returns a function that stops it.
 */
export const startNotifier = (
  store: Pick<StateStore, "snapshot" | "subscribe">,
  push: { send: (notice: Notice) => Promise<unknown> }
): (() => void) => {
  let previous = store.snapshot();
  return store.subscribe(() => {
    const next = store.snapshot();
    const notices = diffForNotifications(previous, next);
    previous = next;
    for (const notice of notices) {
      void push.send(notice).catch(() => undefined);
    }
  });
};
