import { lazy, Suspense } from "react";

import type ChangedFilesTreeComponent from "./changed-files-tree";
import { FilesTreeSkeleton } from "./skeletons";

// @pierre/trees is only needed on the Review tab; load it there rather than with the dashboard.
const Loaded = lazy(() => import("./changed-files-tree"));

export const ChangedFilesTree = (
  props: Parameters<typeof ChangedFilesTreeComponent>[0]
) => (
  <Suspense fallback={<FilesTreeSkeleton />}>
    <Loaded {...props} />
  </Suspense>
);
