import { Environments } from "./environments/environments";
import type { HubDeps } from "./environments/ports";
import { BasePositions } from "./git/base-position";
import { Checkouts } from "./git/checkouts";
import { CleanupTargets } from "./git/cleanup-targets";
import { ReviewActions } from "./git/review-actions";
import { Chat } from "./sessions/chat";
import { SavedPermissions } from "./sessions/saved-permissions";
import { Sessions } from "./sessions/sessions";
import { CheckoutSetup } from "./tasks/checkout-setup";
import { Tasks } from "./tasks/tasks";

/** What the Hub does for its projects, one module per concern; all of them act on the same Environments. */
export interface Hub {
  chat: Chat;
  environments: Environments;
  sessions: Sessions;
  tasks: Tasks;
  checkouts: Checkouts;
  reviews: ReviewActions;
  cleanupTargets: CleanupTargets;
  permissions: SavedPermissions;
  bases: BasePositions;
}

export const createHub = (deps: HubDeps): Hub => {
  const environments = new Environments(deps);
  const sessions = new Sessions(deps, environments);
  const checkouts = new Checkouts(deps, environments, sessions);
  const bases = new BasePositions(deps, environments);
  const cleanupTargets = new CleanupTargets(
    deps,
    environments,
    checkouts,
    bases.freshness
  );
  const setup = new CheckoutSetup(deps, environments, bases);
  const tasks = new Tasks(deps, environments, setup, cleanupTargets);
  return {
    bases,
    chat: new Chat(deps, environments, sessions, setup, tasks),
    checkouts,
    cleanupTargets,
    environments,
    permissions: new SavedPermissions(deps, environments),
    reviews: new ReviewActions(deps, environments, sessions, checkouts),
    sessions,
    tasks,
  };
};
