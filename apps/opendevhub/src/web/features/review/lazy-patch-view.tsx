import { lazy, Suspense } from "react";

import { DiffLinesSkeleton } from "../../components/skeletons";
import type PatchViewComponent from "./patch-view";

// @pierre/diffs and Shiki are large; load them with the first diff on screen rather than with the dashboard.
const Loaded = lazy(
  () => import("./patch-view")
) as unknown as typeof PatchViewComponent;

export const PatchView = <A = undefined,>(
  props: Parameters<typeof PatchViewComponent<A>>[0]
) => (
  <Suspense fallback={<DiffLinesSkeleton />}>
    <Loaded<A> {...props} />
  </Suspense>
);
