import { Button } from "@opendevhub/ui/button";
import {
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  FolderIcon,
  MinusIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import type { ReviewFile } from "../../../shared/types";
import type { StageChange } from "./hunk-controls";
import { fileTree, folderPaths } from "./stage";
import type { FileTreeNode, Selection } from "./stage";

const STATUS = {
  added: { className: "text-ok", letter: "A" },
  deleted: { className: "text-destructive", letter: "D" },
  modified: { className: "text-warn", letter: "M" },
} as const;

/** How far each tree level sits in from its parent, in px. */
const INDENT = 12;

const StageButton = (props: {
  staged: boolean;
  label: string;
  title: string;
  paths: string[];
  disabled: boolean;
  change: StageChange;
}) => (
  <Button
    variant="ghost"
    size="icon-xs"
    aria-label={`${props.staged ? "Unstage" : "Stage"} ${props.label}`}
    title={`${props.staged ? "Unstage" : "Stage"} ${props.title}`}
    disabled={props.disabled}
    onClick={() =>
      props.change(props.staged ? "unstage" : "stage", { paths: props.paths })
    }
  >
    {props.staged ? <MinusIcon /> : <PlusIcon />}
  </Button>
);

interface TreeProps {
  staged: boolean;
  selection?: Selection;
  disabled: boolean;
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onSelect: (selection: Selection) => void;
  change: StageChange;
}

const FileRow = (
  props: TreeProps & {
    node: Extract<FileTreeNode, { kind: "file" }>;
    depth: number;
  }
) => {
  const { file } = props.node;
  const { staged } = props;
  const status = STATUS[file.status];
  const selected =
    props.selection?.file === file.file && props.selection.staged === staged;
  return (
    <li
      className={cn(
        "group/row hover:bg-accent/60 flex items-center gap-1 rounded-md pr-1",
        selected && "bg-accent text-accent-foreground"
      )}
    >
      <button
        type="button"
        aria-current={selected}
        className="flex min-w-0 flex-1 items-center gap-2 py-1 pr-2 text-left text-sm"
        style={{ paddingLeft: 8 + props.depth * INDENT + 18 }}
        title={file.file}
        onClick={() => props.onSelect({ file: file.file, staged })}
      >
        <span
          className={cn("w-3 shrink-0 font-mono text-xs", status.className)}
          aria-hidden
        >
          {status.letter}
        </span>
        <span className="min-w-0 truncate">{props.node.name}</span>
        <span className="ml-auto font-mono text-xs whitespace-nowrap tabular-nums">
          <span className="text-ok">+{file.additions}</span>{" "}
          <span className="text-destructive">−{file.deletions}</span>
        </span>
      </button>
      <StageButton
        staged={staged}
        label={file.file}
        title="file"
        paths={[file.file]}
        disabled={props.disabled}
        change={props.change}
      />
    </li>
  );
};

const FolderRow = (
  props: TreeProps & {
    node: Extract<FileTreeNode, { kind: "folder" }>;
    depth: number;
  }
) => {
  const { node, staged } = props;
  const key = `${staged}:${node.path}`;
  const open = !props.collapsed.has(key);
  return (
    <li>
      <div className="hover:bg-accent/60 flex items-center gap-1 rounded-md pr-1">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pr-2 text-left text-sm"
          style={{ paddingLeft: 8 + props.depth * INDENT }}
          title={node.path}
          onClick={() => props.onToggle(key)}
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "text-muted-foreground size-3.5 shrink-0 transition-transform",
              open && "rotate-90"
            )}
          />
          <FolderIcon
            aria-hidden
            className="text-muted-foreground size-3.5 shrink-0"
          />
          <span className="text-muted-foreground min-w-0 truncate">
            {node.name}
          </span>
          {!open && (
            <span className="text-muted-foreground ml-auto text-xs tabular-nums">
              {node.files.length}
            </span>
          )}
        </button>
        <StageButton
          staged={staged}
          label={node.path}
          title="folder"
          paths={node.files.map((f) => f.file)}
          disabled={props.disabled}
          change={props.change}
        />
      </div>
      {open && (
        <TreeRows {...props} nodes={node.children} depth={props.depth + 1} />
      )}
    </li>
  );
};

const TreeRows = (
  props: TreeProps & { nodes: FileTreeNode[]; depth: number }
) => {
  const { nodes, ...rest } = props;
  return (
    <ul className="flex flex-col">
      {nodes.map((node) =>
        node.kind === "folder" ? (
          <FolderRow key={node.path} {...rest} node={node} />
        ) : (
          <FileRow key={node.file.file} {...rest} node={node} />
        )
      )}
    </ul>
  );
};

const Group = (
  props: Omit<TreeProps, "staged"> & {
    title: string;
    files: ReviewFile[];
    staged: boolean;
  }
) => {
  const { title, files, staged, ...rest } = props;
  const nodes = fileTree(files);
  return (
    <section aria-label={title} className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 px-2">
        <h3 className="text-sm font-medium">
          {title}{" "}
          <span className="text-muted-foreground tabular-nums">
            ({files.length})
          </span>
        </h3>
        {files.length > 0 && (
          <Button
            variant="outline"
            size="xs"
            disabled={props.disabled}
            onClick={() => props.change(staged ? "unstage" : "stage", {})}
          >
            {staged ? "Unstage all" : "Stage all"}
          </Button>
        )}
      </div>
      {files.length === 0 ? (
        <p className="text-muted-foreground px-2 py-1 text-xs">
          {staged ? "Nothing staged yet." : "Everything is staged."}
        </p>
      ) : (
        <TreeRows {...rest} staged={staged} nodes={nodes} depth={0} />
      )}
    </section>
  );
};

/** The changed files as git sees them, in two folder trees: still only in the working tree, and staged for the commit. */
export const FileGroups = (props: {
  unstaged: ReviewFile[];
  staged: ReviewFile[];
  selection?: Selection;
  disabled: boolean;
  onSelect: (selection: Selection) => void;
  change: StageChange;
}) => {
  const { unstaged, staged, ...rest } = props;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const folders = [
    ...folderPaths(fileTree(unstaged)).map((p) => `false:${p}`),
    ...folderPaths(fileTree(staged)).map((p) => `true:${p}`),
  ];
  const allOpen = !folders.some((key) => collapsed.has(key));
  const onToggle = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  const tree = { ...rest, collapsed, onToggle };
  return (
    <div className="flex flex-col gap-3 p-2">
      {folders.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="text-muted-foreground self-start"
          onClick={() => setCollapsed(allOpen ? new Set(folders) : new Set())}
        >
          {allOpen ? <ChevronsDownUpIcon /> : <ChevronsUpDownIcon />}
          {allOpen ? "Collapse all" : "Expand all"}
        </Button>
      )}
      <Group title="Unstaged" files={unstaged} staged={false} {...tree} />
      <Group title="Staged" files={staged} staged {...tree} />
    </div>
  );
};
