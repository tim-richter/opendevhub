import type { BaseSkipReason } from "./types";

/** Why `base` wasn't brought up to its upstream, as a clause: "the main checkout has uncommitted changes". */
export const baseSkipText = (
  reason: BaseSkipReason,
  base: string,
  remote?: string
): string => {
  switch (reason) {
    case "dirty": {
      return "the main checkout has uncommitted changes";
    }
    case "diverged": {
      return `${base} has local commits that aren't on ${remote ?? "its upstream"}`;
    }
    case "no-upstream": {
      return `${base} has no upstream`;
    }
    case "fetch-failed": {
      return `fetching ${remote ?? "the remote"} failed`;
    }
    default: {
      return "updating the base before a task is turned off";
    }
  }
};
