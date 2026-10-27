import { Card } from "@opendevhub/ui/card";
import type { ReactNode } from "react";

import type { ReviewFile } from "../../../shared/types";
import { Tip } from "../../components/tip";
import { ChangedFilesTree } from "./lazy-changed-files-tree";

const ROW_REM = 1.75;
/** Rows beyond the files themselves: their folders, and a little breathing room. */
const EXTRA_ROWS = 2;

/** A tree as tall as its rows need, up to a share of the screen. */
const treeHeight = (files: number) =>
  `min(${(files + EXTRA_ROWS) * ROW_REM}rem, 40vh)`;

/** Left of the diffs: the changed files, then the panel that says what to do next. Both stay in view while scrolling. */
export const ReviewSidebar = (props: {
  files: ReviewFile[];
  /** Files marked viewed; undefined when this diff doesn't track it. */
  viewedCount?: number;
  showFiles: boolean;
  /** Replaces the tree, e.g. with the staged and unstaged lists. */
  list?: ReactNode;
  onSelect: (file: string) => void;
  children: ReactNode;
}) => {
  const { files, viewedCount } = props;
  return (
    <aside className="flex min-w-0 flex-col gap-3 max-md:flex-col-reverse md:sticky md:top-[calc(var(--review-bar-top,0px)+var(--review-bar-height,3rem)+1rem)] md:max-h-[calc(100dvh-var(--review-bar-top,0px)-var(--review-bar-height,3rem)-2rem)] md:overflow-y-auto">
      {props.list && (
        <Card className="max-h-[40vh] gap-0 overflow-y-auto py-0">
          {props.list}
        </Card>
      )}
      {!props.list && props.showFiles && files.length > 0 && (
        <Card className="gap-0 overflow-hidden py-0">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2 text-sm">
            <span className="font-medium">
              {files.length} changed file{files.length === 1 ? "" : "s"}
            </span>
            {viewedCount !== undefined && (
              <Tip label="Files marked viewed">
                <span className="text-muted-foreground tabular-nums">
                  {viewedCount}/{files.length} viewed
                </span>
              </Tip>
            )}
          </div>
          <ChangedFilesTree
            files={files}
            onSelect={props.onSelect}
            height={treeHeight(files.length)}
          />
        </Card>
      )}
      {props.children}
    </aside>
  );
};
