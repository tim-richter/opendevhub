import { type DiffLineAnnotation, type FileDiffOptions, PatchDiff, type SelectedLineRange } from "@pierre/diffs/react";
import { type ReactNode, useMemo, useState } from "react";

/** Unified diffs with syntax highlighting that follow the system's light or dark scheme, like the rest of the UI. */
const BASE_OPTIONS = {
  theme: { dark: "pierre-dark", light: "pierre-light" },
  themeType: "system",
  diffStyle: "unified",
  hunkSeparators: "line-info-basic",
  overflow: "wrap",
} as const;

/**
 * One file's patch, rendered by `@pierre/diffs`. Import it through `LazyPatchView` so the highlighter loads
 * only when a diff is shown. With `onComment`, the gutter shows a "+" button: a click or drag
 * reports the selected line range, highlighted while dragging. Callbacks and annotations should be stable
 * (memoized) across renders.
 */
export default function PatchView<A = undefined>(props: {
  patch: string;
  collapsed?: boolean;
  disableHeader?: boolean;
  onComment?: (range: SelectedLineRange) => void;
  annotations?: DiffLineAnnotation<A>[];
  /** Controlled line selection; pass null to clear it. */
  selectedLines?: SelectedLineRange | null;
  renderAnnotation?: (annotation: DiffLineAnnotation<A>) => ReactNode;
  renderHeaderPrefix?: () => ReactNode;
}) {
  const { collapsed, disableHeader, onComment } = props;
  // A controlled selection isn't painted while the gutter is dragged, so the drag's range is shown from here.
  const [dragged, setDragged] = useState<SelectedLineRange | null>(null);
  const options = useMemo<FileDiffOptions<A, undefined>>(
    () => ({
      ...BASE_OPTIONS,
      collapsed,
      disableFileHeader: disableHeader,
      ...(onComment
        ? {
            enableGutterUtility: true,
            onGutterUtilityClick: onComment,
            onLineSelectionStart: setDragged,
            onLineSelectionChange: setDragged,
            onLineSelectionEnd: () => setDragged(null),
          }
        : {}),
    }),
    [collapsed, disableHeader, onComment],
  );
  return (
    <PatchDiff<A, undefined>
      patch={props.patch}
      options={options}
      lineAnnotations={props.annotations}
      selectedLines={dragged ?? props.selectedLines}
      renderAnnotation={props.renderAnnotation}
      renderHeaderPrefix={props.renderHeaderPrefix}
    />
  );
}
