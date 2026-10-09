import { lazy, Suspense } from "react";

import { FilesTreeSkeleton } from "../../components/skeletons";
import type ChangedFilesTreeComponent from "./changed-files-tree";

// @pierre/trees is only needed on the Review tab; load it there rather than with the dashboard.
const Loaded = lazy(() => import("./changed-files-tree"));

export const ChangedFilesTree = (
  props: Parameters<typeof ChangedFilesTreeComponent>[0]
) => (
  <Suspense fallback={<FilesTreeSkeleton />}>
    <Loaded {...props} />
  </Suspense>
);
