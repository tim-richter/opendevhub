import preview from "../../../../.storybook/preview";
import type { DashboardSnapshot, ProjectView } from "../../../shared/types";
import { App } from "../../app";
import { basePosition, snapshot } from "../../mocks/fixtures";
import { mockApi } from "../../mocks/story";

/** The widths the task page's layout changes at: phone, icon sidebar, laptop strip, wide rail. */
const VIEWPORTS = {
  laptop: {
    name: "Laptop (1280)",
    styles: { height: "800px", width: "1280px" },
  },
  narrow: {
    name: "Narrow laptop (900)",
    styles: { height: "800px", width: "900px" },
  },
  phone: { name: "Phone (390)", styles: { height: "844px", width: "390px" } },
  wide: { name: "Wide (1440)", styles: { height: "900px", width: "1440px" } },
};

const at = (value: keyof typeof VIEWPORTS) => ({
  viewport: { isRotated: false, value },
});

/** The snapshot with billing-api's project changed by `edit`. */
const withBilling = (
  edit: (view: ProjectView) => ProjectView
): DashboardSnapshot => ({
  ...snapshot,
  projects: snapshot.projects.map((p) =>
    p.project.id === "billing-api" ? edit(p) : p
  ),
});

/** tsk_round with variant 1 waiting on a permission and variant 2 working. */
const needsYou = withBilling((view) => ({
  ...view,
  sessions: view.sessions.map((s) =>
    s.task?.n === 1 ? { ...s, status: "needs-permission" } : s
  ),
}));

/** tsk_round after variant 2 was picked and variant 1 discarded. */
const picked = withBilling((view) => ({
  ...view,
  sessions: view.sessions.filter((s) => s.task?.n !== 1),
  tasks: view.tasks.map((t) => ({
    ...t,
    variants: t.variants.map((v) =>
      v.n === 1 ? { ...v, discarded: true } : { ...v, picked: true }
    ),
  })),
}));

const meta = preview.meta({
  component: App,
  parameters: {
    route: "/p/acme-web/t/tsk_rate",
    viewport: { options: VIEWPORTS },
  },
  title: "Pages/Task",
});

/** A running task from a Jira ticket, published as a PR: one variant, so no variant cards, Compare or "V1" labels. */
export const Default = meta.story();

/** The full review of the variant, on its own page: diffs, comments, AI review, publish and merge. */
export const ReviewPage = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_rate/review" },
});

/** The selected variant's terminal, filling the tab. */
export const Terminal = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_rate/terminal" },
});

/** The selected variant's container controls, ports and logs by source. */
export const Runtime = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_rate/runtime" },
});

/** Two variants, the second selected: its card is marked, the composer reads "To V2 · …". */
export const Variants = meta.story({
  parameters: { route: "/p/billing-api/t/tsk_round?v=2" },
});

/** Variant 1 waits on a permission while variant 2 works: the header reads Needs you. */
export const NeedsYou = meta.story({
  beforeEach: mockApi({ snapshot: needsYou }),
  parameters: { route: "/p/billing-api/t/tsk_round" },
});

/** After a pick: one active variant, so the variant UI is gone and Pick variant is done. */
export const Picked = meta.story({
  beforeEach: mockApi({ snapshot: picked }),
  parameters: { route: "/p/billing-api/t/tsk_round" },
});

/** Every variant side by side, with Pick; opened from Compare variants. */
export const Compare = meta.story({
  parameters: { route: "/p/billing-api/t/tsk_round/compare" },
});

/** Variants still starting: one pulling its image, one failed; the selected one's setup log fills the main area. */
export const Starting = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_search" },
});

/** The failed variant selected: its error, setup log and Dismiss. */
export const StartingFailed = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_search?v=2" },
});

/** A draft from a Jira ticket, planned but not started. */
export const Draft = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_sso" },
});

/** An ended AI review of a pull request: no stepper; Review changes and, in the menu, Archive. */
export const Review = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_review42" },
});

/** A task id that isn't in the project. */
export const NotFound = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_gone" },
});

/** Phone: back link, Step n of m, the V1/V2 control, scrolling tabs with Checks, the branch chip. */
export const Phone = meta.story({
  globals: at("phone"),
  parameters: { route: "/p/billing-api/t/tsk_round" },
});

/** Phone, single variant: no variant control. */
export const PhoneSingle = meta.story({
  globals: at("phone"),
});

/** Phone, Checks tab: the status rail's content. */
export const PhoneChecks = meta.story({
  globals: at("phone"),
  parameters: { route: "/p/acme-web/t/tsk_rate/checks" },
});

/** 900px: the sidebar as an icon strip, conversations in a popover, the status strip on the tab row. */
export const NarrowLaptop = meta.story({
  globals: at("narrow"),
  parameters: { route: "/p/billing-api/t/tsk_round" },
});

/** 1280px: the full sidebar, and the status strip instead of the rail. */
export const Laptop = meta.story({
  globals: at("laptop"),
  parameters: { route: "/p/billing-api/t/tsk_round" },
});

/** 1440px: sidebar, main and the status rail. */
export const Wide = meta.story({
  globals: at("wide"),
  parameters: { route: "/p/billing-api/t/tsk_round" },
});

/** The snapshot with acme-web's project changed by `edit`. */
const withWeb = (
  edit: (view: ProjectView) => ProjectView
): DashboardSnapshot => ({
  ...snapshot,
  projects: snapshot.projects.map((p) =>
    p.project.id === "acme-web" ? edit(p) : p
  ),
});

/** tsk_rate run in the main checkout instead of a worktree. */
const inMainCheckout = withWeb((view) => ({
  ...view,
  tasks: view.tasks.map((t) =>
    t.id === "tsk_rate"
      ? {
          ...t,
          variants: t.variants.map((v) => ({
            ...v,
            branch: "main",
            directory: view.runtime.workspaceFolder ?? "/workspaces/acme-web",
          })),
        }
      : t
  ),
}));

const LONG_BRANCH =
  "feat/ACME-118-login-endpoint-needs-burst-protection-against-credential-stuffing";

/** tsk_rate on a branch whose name is far wider than the rail. */
const longBranch = withWeb((view) => ({
  ...view,
  runtime: {
    ...view.runtime,
    worktrees: view.runtime.worktrees?.map((w) =>
      w.branch === "feat/rate-limit" ? { ...w, branch: LONG_BRANCH } : w
    ),
  },
  tasks: view.tasks.map((t) =>
    t.id === "tsk_rate"
      ? {
          ...t,
          variants: t.variants.map((v) => ({ ...v, branch: LONG_BRANCH })),
        }
      : t
  ),
}));

/** `origin/main` gained 4 commits since the branch was made, and local `main` lacks them: Pull is offered. */
export const PositionBehind = meta.story({
  beforeEach: mockApi({
    basePosition: (base) =>
      basePosition(base, {
        behind: 4,
        branchAhead: 2,
        sinceBranch: 4,
        update: { commits: 4, kind: "ff" },
      }),
    review: (d) => ({ ...d, ahead: 2, behind: 0, dirty: false }),
  }),
  globals: at("wide"),
});

/** The branch is 3 ahead of `origin/main` and 2 behind it; `main` itself is up to date. */
export const PositionAheadAndBehind = meta.story({
  beforeEach: mockApi({
    basePosition: (base) =>
      basePosition(base, { branchAhead: 3, sinceBranch: 2 }),
    review: (d) => ({ ...d, ahead: 3, behind: 2, dirty: false }),
  }),
  globals: at("wide"),
});

/** The same at 1280px: no rail, and the strip reads ↑3 ↓2. */
export const StripAheadAndBehind = meta.story({
  beforeEach: mockApi({
    basePosition: (base) =>
      basePosition(base, { branchAhead: 3, sinceBranch: 2 }),
    review: (d) => ({ ...d, ahead: 3, behind: 2, dirty: false }),
  }),
  globals: at("laptop"),
});

/** Pushed once, with 2 commits made since. */
export const PositionUnpushed = meta.story({
  beforeEach: mockApi({
    basePosition: (base) => basePosition(base, { branchAhead: 5 }),
    review: (d) => ({
      ...d,
      ahead: 5,
      behind: 0,
      dirty: false,
      pushed: true,
      upstreamAhead: 2,
    }),
  }),
  globals: at("wide"),
});

/** The main checkout has uncommitted changes, so Pull is disabled and says why. */
export const PositionDirty = meta.story({
  beforeEach: mockApi({
    basePosition: (base) =>
      basePosition(base, {
        behind: 4,
        branchAhead: 2,
        sinceBranch: 4,
        update: { kind: "skip", reason: "dirty" },
      }),
  }),
  globals: at("wide"),
});

/** A variant in the main checkout is on the base: only `origin/main` and `main`. */
export const PositionMainCheckout = meta.story({
  beforeEach: mockApi({
    basePosition: (base) =>
      basePosition(base, {
        ahead: 1,
        behind: 2,
        update: { kind: "skip", reason: "diverged" },
      }),
    snapshot: inMainCheckout,
  }),
  globals: at("wide"),
});

/** A branch name far wider than the rail and the strip. */
export const PositionLongBranch = meta.story({
  beforeEach: mockApi({
    basePosition: (base) =>
      basePosition(base, { branchAhead: 1234, sinceBranch: 87 }),
    review: (d) => ({ ...d, ahead: 1234, behind: 87, branch: LONG_BRANCH }),
    snapshot: longBranch,
  }),
  globals: at("wide"),
});
