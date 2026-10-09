import type { ForgejoPullDetails } from "../../../shared/forgejo";
import { fetchPublishInfo } from "../../api";
import { useDash } from "../../dashboard-context";
import { checkouts } from "../checkouts/checkouts";
import { matchesForgejoCheckout, matchesForgejoPull } from "./forgejo";
import { useForgejoQuery } from "./use-forgejo";

export interface ForgejoCheckoutMatch {
  projectId: string;
  directory: string;
  /** The checkout is the pull request's branch or commit, not just a clone of its repository. */
  exact: boolean;
}

/** Running local checkouts of the pull request's repository, its own checkouts first. */
export const useForgejoCheckouts = (details: ForgejoPullDetails) => {
  const { snapshot } = useDash();
  const projects = snapshot?.projects ?? [];
  const fingerprint = projects.map((p) => [
    p.project.id,
    p.runtime.containerState,
    p.runtime.worktrees?.map((w) => [w.path, w.head, w.branch]),
  ]);
  return useForgejoQuery(
    ["local-links", details.pull.url, details.headSha, fingerprint],
    async (signal) => {
      const candidates = projects
        .filter((p) => p.runtime.containerState === "running")
        .flatMap((view) =>
          checkouts(view).map((checkout) => ({ checkout, view }))
        );
      const matches: ForgejoCheckoutMatch[] = [];
      let skipped = 0;
      const queue = [...candidates];
      // Bound git work to four checkouts at once; inspect all remotes so forks work too.
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length && !signal.aborted) {
            const item = queue.shift();
            if (!item) {
              break;
            }
            try {
              let info = await fetchPublishInfo(
                item.view.project.id,
                item.checkout.directory,
                undefined,
                signal
              );
              if (!matchesForgejoPull(details, info)) {
                for (const remote of info.remotes.filter(
                  (r) => r !== info.remote
                )) {
                  info = await fetchPublishInfo(
                    item.view.project.id,
                    item.checkout.directory,
                    remote,
                    signal
                  );
                  if (matchesForgejoPull(details, info)) {
                    break;
                  }
                }
              }
              if (matchesForgejoPull(details, info)) {
                matches.push({
                  directory: item.checkout.directory,
                  exact: matchesForgejoCheckout(
                    details,
                    info,
                    item.checkout.worktree?.head
                  ),
                  projectId: item.view.project.id,
                });
              }
            } catch {
              if (!signal.aborted) {
                skipped += 1;
              }
            }
          }
        })
      );
      return {
        matches: matches.toSorted(
          (a, b) =>
            Number(b.exact) - Number(a.exact) ||
            a.projectId.localeCompare(b.projectId)
        ),
        skipped,
      };
    }
  );
};
