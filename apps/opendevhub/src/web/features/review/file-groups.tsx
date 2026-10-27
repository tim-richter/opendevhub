import { Button } from "@opendevhub/ui/button";
import { MinusIcon, PlusIcon } from "lucide-react";

import { cn } from "@/lib/utils";

import type { ReviewFile } from "../../../shared/types";
import type { StageChange } from "./hunk-controls";
import type { Selection } from "./stage";

const STATUS = {
  added: { className: "text-ok", letter: "A" },
  deleted: { className: "text-destructive", letter: "D" },
  modified: { className: "text-warn", letter: "M" },
} as const;

const FileRow = (props: {
  file: ReviewFile;
  staged: boolean;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  change: StageChange;
}) => {
  const { file, staged, selected, disabled } = props;
  const slash = file.file.lastIndexOf("/") + 1;
  const status = STATUS[file.status];
  const verb = staged ? "Unstage" : "Stage";
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
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm"
        onClick={props.onSelect}
      >
        <span
          className={cn("w-3 shrink-0 font-mono text-xs", status.className)}
          aria-hidden
        >
          {status.letter}
        </span>
        <span className="min-w-0 truncate" title={file.file}>
          <span className="text-muted-foreground">
            {file.file.slice(0, slash)}
          </span>
          <span className="font-medium">{file.file.slice(slash)}</span>
        </span>
        <span className="ml-auto font-mono text-xs whitespace-nowrap tabular-nums">
          <span className="text-ok">+{file.additions}</span>{" "}
          <span className="text-destructive">−{file.deletions}</span>
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`${verb} ${file.file}`}
        title={`${verb} file`}
        disabled={disabled}
        onClick={() =>
          props.change(staged ? "unstage" : "stage", { paths: [file.file] })
        }
      >
        {staged ? <MinusIcon /> : <PlusIcon />}
      </Button>
    </li>
  );
};

const Group = (props: {
  title: string;
  files: ReviewFile[];
  staged: boolean;
  selection?: Selection;
  disabled: boolean;
  onSelect: (selection: Selection) => void;
  change: StageChange;
}) => {
  const { title, files, staged } = props;
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
        <ul className="flex flex-col">
          {files.map((file) => (
            <FileRow
              key={file.file}
              file={file}
              staged={staged}
              selected={
                props.selection?.file === file.file &&
                props.selection.staged === staged
              }
              disabled={props.disabled}
              change={props.change}
              onSelect={() => props.onSelect({ file: file.file, staged })}
            />
          ))}
        </ul>
      )}
    </section>
  );
};

/** The changed files as git sees them, in two lists: still only in the working tree, and staged for the commit. */
export const FileGroups = (props: {
  unstaged: ReviewFile[];
  staged: ReviewFile[];
  selection?: Selection;
  disabled: boolean;
  onSelect: (selection: Selection) => void;
  change: StageChange;
}) => {
  const { unstaged, staged, ...rest } = props;
  return (
    <div className="flex flex-col gap-3 p-2">
      <Group title="Unstaged" files={unstaged} staged={false} {...rest} />
      <Group title="Staged" files={staged} staged {...rest} />
    </div>
  );
};
