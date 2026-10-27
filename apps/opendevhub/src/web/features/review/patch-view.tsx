import {
  MultiFileDiff,
  PatchDiff,
  WorkerPoolContext,
} from "@pierre/diffs/react";
import type {
  DiffLineAnnotation,
  FileDiffOptions,
  SelectedLineRange,
} from "@pierre/diffs/react";
import { getOrCreateWorkerPoolSingleton } from "@pierre/diffs/worker";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { fileVersions } from "./review";

const MAX_DIFF_WORKERS = 4;

/** Only one highlighter type can be active at a time, so the pool and every diff component must agree. */
const HIGHLIGHTER = "highlights";

/**
 * One pool for every diff on the page: parsing and highlighting run in workers instead of blocking the main
 * thread, and results are cached, so reopening a diff doesn't highlight it again.
 */
const workerPool =
  typeof Worker === "undefined"
    ? undefined
    : getOrCreateWorkerPoolSingleton({
        highlighterOptions: {
          preferredHighlighter: HIGHLIGHTER,
          theme: { dark: "pierre-dark", light: "pierre-light" },
        },
        poolOptions: {
          poolSize: Math.max(
            1,
            Math.min(MAX_DIFF_WORKERS, (navigator.hardwareConcurrency || 2) - 1)
          ),
          workerFactory: () =>
            new Worker(
              new URL("@pierre/diffs/worker/worker.js", import.meta.url),
              { type: "module" }
            ),
        },
      });

/** Diffs with syntax highlighting that follow the system's light or dark scheme, like the rest of the UI. */
export const BASE_OPTIONS = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
  preferredHighlighter: HIGHLIGHTER,
  hunkSeparators: "line-info",
  overflow: "wrap",
  // Lines of context around each change while unchanged lines are hidden.
  parseDiffOptions: { context: 3 },
} as const;

/**
 * One file's patch, rendered by `@pierre/diffs`. Import it through `LazyPatchView` so the highlighter loads
 * only when a diff is shown. With `onComment`, the gutter shows a "+" button: a click or drag
 * reports the selected line range, highlighted while dragging. Callbacks and annotations should be stable
 * (memoized) across renders.
 */
export default function PatchView<A = undefined>(props: {
  patch: string;
  /** The file's path. With it, a patch holding the whole file renders from both versions, hiding unchanged lines. */
  name?: string;
  /** Side by side instead of one column. */
  split?: boolean;
  /** Every line of the file instead of only the changes with a few lines around them. */
  fullFile?: boolean;
  collapsed?: boolean;
  disableHeader?: boolean;
  onComment?: (range: SelectedLineRange) => void;
  annotations?: DiffLineAnnotation<A>[];
  /** Controlled line selection; pass null to clear it. */
  selectedLines?: SelectedLineRange | null;
  renderAnnotation?: (annotation: DiffLineAnnotation<A>) => ReactNode;
  renderHeaderPrefix?: () => ReactNode;
  /** Drawn at the end of the header, after the file's stats. */
  renderHeaderMetadata?: () => ReactNode;
}) {
  const { collapsed, disableHeader, onComment, split, fullFile, name } = props;
  // A controlled selection isn't painted while the gutter is dragged, so the drag's range is shown from here.
  const [dragged, setDragged] = useState<SelectedLineRange | null>(null);
  const options = useMemo<FileDiffOptions<A, undefined>>(
    () => ({
      ...BASE_OPTIONS,
      collapsed,
      diffStyle: split ? "split" : "unified",
      disableFileHeader: disableHeader,
      expandUnchanged: !!fullFile,
      ...(onComment
        ? {
            enableGutterUtility: true,
            onGutterUtilityClick: onComment,
            onLineSelectionChange: setDragged,
            onLineSelectionEnd: () => setDragged(null),
            onLineSelectionStart: setDragged,
          }
        : {}),
    }),
    [collapsed, disableHeader, onComment, split, fullFile]
  );
  const files = useMemo(() => {
    if (name === undefined) {
      return;
    }
    const versions = fileVersions(props.patch);
    return (
      versions && {
        newFile: { contents: versions.new, name },
        oldFile: { contents: versions.old, name },
      }
    );
  }, [name, props.patch]);
  const shared = {
    lineAnnotations: props.annotations,
    options,
    renderAnnotation: props.renderAnnotation,
    renderHeaderMetadata: props.renderHeaderMetadata,
    renderHeaderPrefix: props.renderHeaderPrefix,
    selectedLines: dragged ?? props.selectedLines,
  };
  return (
    <WorkerPoolContext.Provider value={workerPool}>
      {files ? (
        <MultiFileDiff<A, undefined>
          oldFile={files.oldFile}
          newFile={files.newFile}
          {...shared}
        />
      ) : (
        <PatchDiff<A, undefined> patch={props.patch} {...shared} />
      )}
    </WorkerPoolContext.Provider>
  );
}
