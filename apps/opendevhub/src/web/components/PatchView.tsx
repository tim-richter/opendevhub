import { type DiffLineAnnotation, type FileDiffOptions, MultiFileDiff, PatchDiff, type SelectedLineRange } from "@pierre/diffs/react";
import { type ReactNode, useMemo, useState } from "react";
import { fileVersions } from "../review";

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
      diffStyle: split ? "split" : "unified",
      expandUnchanged: !!fullFile,
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
    [collapsed, disableHeader, onComment, split, fullFile],
  );
  const files = useMemo(() => {
    if (name === undefined) return undefined;
    const versions = fileVersions(props.patch);
    return versions && { oldFile: { name, contents: versions.old }, newFile: { name, contents: versions.new } };
  }, [name, props.patch]);
  const shared = {
    options,
    lineAnnotations: props.annotations,
    selectedLines: dragged ?? props.selectedLines,
    renderAnnotation: props.renderAnnotation,
    renderHeaderPrefix: props.renderHeaderPrefix,
  };
  return files ? (
    <MultiFileDiff<A, undefined> oldFile={files.oldFile} newFile={files.newFile} {...shared} />
  ) : (
    <PatchDiff<A, undefined> patch={props.patch} {...shared} />
  );
}
