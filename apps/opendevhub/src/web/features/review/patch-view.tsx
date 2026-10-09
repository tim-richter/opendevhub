import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import type {
  DiffLineAnnotation,
  FileDiffOptions,
  SelectedLineRange,
} from "@pierre/diffs/react";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";

import { fileVersions } from "./review";

/** Diffs with syntax highlighting that follow the system's light or dark scheme, like the rest of the UI. */
const BASE_OPTIONS = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
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
    renderHeaderPrefix: props.renderHeaderPrefix,
    selectedLines: dragged ?? props.selectedLines,
  };
  return files ? (
    <MultiFileDiff<A, undefined>
      oldFile={files.oldFile}
      newFile={files.newFile}
      {...shared}
    />
  ) : (
    <PatchDiff<A, undefined> patch={props.patch} {...shared} />
  );
}
