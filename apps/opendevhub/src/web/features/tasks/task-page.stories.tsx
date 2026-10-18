import { http, HttpResponse } from "msw";

import preview from "../../../../.storybook/preview";
import type { DashboardSnapshot, ProjectView } from "../../../shared/types";
import { App } from "../../app";
import { reviewData, snapshot } from "../../mocks/fixtures";
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

/** The changed files only, nothing selected yet; Review changes opens the full review. */
export const Changes = meta.story({
  parameters: { route: "/p/acme-web/t/tsk_rate/changes" },
});

/** One file picked from the list: its diff below. */
export const ChangesFileSelected = meta.story({
  parameters: {
    route: "/p/acme-web/t/tsk_rate/changes?file=src%2Fserver%2Frate-limit.ts",
  },
});

/** A large file, whose patch wasn't sent with the list, loads on its own when picked. */
export const ChangesLargeFile = meta.story({
  parameters: {
    route:
      "/p/acme-web/t/tsk_rate/changes?file=test%2Fserver%2Frate-limit.test.ts",
  },
});

/** A checkout with nothing changed. */
export const ChangesEmpty = meta.story({
  beforeEach: mockApi(
    {},
    http.get("/api/projects/:id/review", ({ request }) =>
      HttpResponse.json({
        ...reviewData(new URL(request.url).searchParams.get("directory") ?? ""),
        dirty: false,
        files: [],
      })
    )
  ),
  parameters: { route: "/p/acme-web/t/tsk_rate/changes" },
});

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
