import { lazy, Suspense } from "react";
import type ChangedFilesTreeComponent from "./ChangedFilesTree";

// @pierre/trees is only needed on the Review tab; load it there rather than with the dashboard.
const Loaded = lazy(() => import("./ChangedFilesTree"));

export function ChangedFilesTree(props: Parameters<typeof ChangedFilesTreeComponent>[0]) {
  return (
    <Suspense fallback={<p className="px-3 py-2.5 text-sm text-muted-foreground">Loading files…</p>}>
      <Loaded {...props} />
    </Suspense>
  );
}
