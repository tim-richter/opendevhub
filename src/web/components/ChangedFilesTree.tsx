import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useRef } from "react";
import type { ReviewFile } from "../../shared/types";
import { statsDecoration, treeGitStatus } from "../review";

/**
 * The review's changed files as a `@pierre/trees` file tree, with git markers and line counts. Import it through
 * `LazyChangedFilesTree` so the tree loads only with the Review tab.
 */
export default function ChangedFilesTree(props: { files: ReviewFile[]; onSelect: (file: string) => void }) {
  // The model is created once; its callbacks read the latest files and handler from refs.
  const files = useRef(props.files);
  files.current = props.files;
  const onSelect = useRef(props.onSelect);
  onSelect.current = props.onSelect;

  const { model } = useFileTree({
    paths: props.files.map((f) => f.file),
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    density: "compact",
    gitStatus: treeGitStatus(props.files),
    renderRowDecoration: ({ item }) => {
      if (item.kind !== "file") return null;
      const file = files.current.find((f) => f.file === item.path);
      return file ? statsDecoration(file) : null;
    },
    onSelectionChange: (paths) => {
      const path = paths.at(-1);
      if (path && files.current.some((f) => f.file === path)) onSelect.current(path);
    },
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
  useEffect(() => model.setGitStatus(treeGitStatus(props.files)), [model, props.files]);

  return <FileTree model={model} className="review-tree" aria-label="Changed files" />;
}
