import { type DiffLineAnnotation, type FileDiffOptions, PatchDiff, type SelectedLineRange } from "@pierre/diffs/react";
import { type ReactNode, useMemo } from "react";

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
 * reports the selected line range. Callbacks and annotations should be stable (memoized) across renders.
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
  const options = useMemo<FileDiffOptions<A, undefined>>(
    () => ({
      ...BASE_OPTIONS,
      collapsed,
      disableFileHeader: disableHeader,
      ...(onComment ? { enableGutterUtility: true, onGutterUtilityClick: onComment } : {}),
    }),
    [collapsed, disableHeader, onComment],
  );
  return (
    <PatchDiff<A, undefined>
      patch={props.patch}
      options={options}
      lineAnnotations={props.annotations}
      selectedLines={props.selectedLines}
      renderAnnotation={props.renderAnnotation}
      renderHeaderPrefix={props.renderHeaderPrefix}
    />
  );
}
