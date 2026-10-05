import { lazy, Suspense } from "react";
import type PatchViewComponent from "./PatchView";
import { DiffLinesSkeleton } from "./Skeletons";

// @pierre/diffs and Shiki are large; load them with the first diff on screen rather than with the dashboard.
const Loaded = lazy(() => import("./PatchView")) as unknown as typeof PatchViewComponent;

export function PatchView<A = undefined>(props: Parameters<typeof PatchViewComponent<A>>[0]) {
  return (
    <Suspense fallback={<DiffLinesSkeleton />}>
      <Loaded<A> {...props} />
    </Suspense>
  );
}
