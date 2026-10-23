import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useLayoutEffect, useRef } from "react";

import type { ReviewFile } from "../../../shared/types";
import { statsDecoration, treeGitStatus } from "./review";

/**
 * The tree shows its "…" marker in a name once the name's measuring cell is taller than one line. At fractional
 * zoom levels (e.g. 110%) every cell measures a hair over one line, so every name got the marker. A name that
 * really overflows wraps to two lines, so half a line of slack keeps the marker for those alone.
 */
const TRUNCATE_FIX = `
  [data-truncate-marker] { opacity: 0; }
  @container measure (height > 1.5lh) { [data-truncate-marker] { opacity: 1; } }
`;

/** The tree sits in a rounded card: rows span it with a small inset, and the first and last keep clear of its corners. */
const CARD_FIT = `
  [data-file-tree-virtualized-scroll="true"] { padding-block: 6px; }
`;

/**
 * The review's changed files as a `@pierre/trees` file tree, with git markers and line counts. Folder chains with a
 * single child, the one all files share included, collapse into one row ("apps / ui").
 * Import it through `LazyChangedFilesTree` so the tree loads only with the Review tab.
 */
export default function ChangedFilesTree(props: {
  files: ReviewFile[];
  onSelect: (file: string) => void;
}) {
  // The model is created once; its callbacks read the latest files and handler from refs.
  const files = useRef(props.files);
  const onSelect = useRef(props.onSelect);
  useLayoutEffect(() => {
    files.current = props.files;
    onSelect.current = props.onSelect;
  }, [props.files, props.onSelect]);

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    gitStatus: treeGitStatus(props.files),
    initialExpansion: "open",
    onSelectionChange: (paths) => {
      const path = paths.at(-1);
      if (path && files.current.some((f) => f.file === path)) {
        onSelect.current(path);
      }
    },
    paths: props.files.map((f) => f.file),
    renderRowDecoration: ({ item }) => {
      if (item.kind !== "file") {
        return null;
      }
      const file = files.current.find((f) => f.file === item.path);
      return file ? statsDecoration(file) : null;
    },
    unsafeCSS: TRUNCATE_FIX + CARD_FIT,
  });

  // Keep the tree in step when a refresh brings different files or statuses.
  const pathsKey = props.files.map((f) => f.file).join("\n");
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    model.resetPaths(pathsKey ? pathsKey.split("\n") : []);
  }, [model, pathsKey]);
  useEffect(
    () => model.setGitStatus(treeGitStatus(props.files)),
    [model, props.files]
  );

  return (
    <FileTree
      model={model}
      className="block h-[min(60vh,32rem)] [--trees-font-family-override:var(--font-sans)] [--trees-padding-inline-override:6px] [--trees-theme-focus-ring:var(--ring)] [--trees-theme-list-active-selection-bg:var(--accent)] [--trees-theme-list-active-selection-fg:var(--accent-foreground)] [--trees-theme-list-hover-bg:color-mix(in_oklab,var(--accent)_60%,transparent)]"
      aria-label="Changed files"
    />
  );
}
