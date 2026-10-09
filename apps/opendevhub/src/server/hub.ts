import { Environments } from "./environments/environments";
import type { HubDeps } from "./environments/ports";
import { Checkouts } from "./git/checkouts";
import { CleanupTargets } from "./git/cleanup-targets";
import { ReviewActions } from "./git/review-actions";
import { Sessions } from "./sessions/sessions";
import { Tasks } from "./tasks/tasks";

/** What the Hub does for its projects, one module per concern; all of them act on the same Environments. */
export interface Hub {
  environments: Environments;
  sessions: Sessions;
  tasks: Tasks;
  checkouts: Checkouts;
  reviews: ReviewActions;
  cleanupTargets: CleanupTargets;
}

export const createHub = (deps: HubDeps): Hub => {
  const environments = new Environments(deps);
  const sessions = new Sessions(deps, environments);
  const checkouts = new Checkouts(deps, environments, sessions);
  return {
    checkouts,
    cleanupTargets: new CleanupTargets(deps, environments, checkouts),
    environments,
    reviews: new ReviewActions(deps, environments, sessions, checkouts),
    sessions,
    tasks: new Tasks(deps, environments),
  };
};
