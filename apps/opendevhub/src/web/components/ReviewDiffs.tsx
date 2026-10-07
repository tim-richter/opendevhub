import { useStableCallback } from "@pierre/diffs/react";
import type {
  DiffLineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs/react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  Columns2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  Rows2Icon,
  XIcon,
} from "lucide-react";
import { Component, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import type { ReviewFile } from "../../shared/types";
import {
  annotationsFor,
  anchorFromRange,
  diffKey,
  linesLabel,
  selectionFor,
} from "../review";
import type {
  DiffView,
  LineAnchor,
  ReviewAnnotation,
  ReviewComment,
} from "../review";
import { ChangedFilesTree } from "./LazyChangedFilesTree";
import { PatchView } from "./LazyPatchView";
import { Note, diffFont } from "./Page";
import { DiffLinesSkeleton } from "./Skeletons";
import { Tip } from "./Tip";

/** The tooltip trigger takes over `data-state`, so a toggle inside one shows its selection from `aria-checked`. */
export const checkedItem =
  "aria-checked:bg-accent aria-checked:text-accent-foreground";

/** Shows or hides the changed-files tree beside the diffs. */
export const FilesToggle = (props: {
  view: DiffView;
  onChange: (change: Partial<DiffView>) => void;
}) => {
  const label = props.view.hideFiles
    ? "Show changed files"
    : "Hide changed files";
  return (
    <Tip label={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={!props.view.hideFiles}
        onClick={() => props.onChange({ hideFiles: !props.view.hideFiles })}
      >
        {props.view.hideFiles ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
      </Button>
    </Tip>
  );
};

/** Unified or side-by-side diffs. */
export const LayoutToggle = (props: {
  view: DiffView;
  onChange: (change: Partial<DiffView>) => void;
}) => (
  <ToggleGroup
    type="single"
    variant="outline"
    size="sm"
    aria-label="Layout"
    value={props.view.split ? "split" : "unified"}
    onValueChange={(v) => v && props.onChange({ split: v === "split" })}
  >
    <Tip label="Unified: one column">
      <ToggleGroupItem
        className={checkedItem}
        value="unified"
        aria-label="Unified"
      >
        <Rows2Icon />
      </ToggleGroupItem>
    </Tip>
    <Tip label="Split: old and new side by side">
      <ToggleGroupItem className={checkedItem} value="split" aria-label="Split">
        <Columns2Icon />
      </ToggleGroupItem>
    </Tip>
  </ToggleGroup>
);

/**
 * The changed files as a tree beside their diffs, with line comments drawn inside the diffs. Without `onAnchor`
 * the diffs are read-only.
 */
export const ReviewDiffs = (props: {
  files: ReviewFile[];
  view: DiffView;
  /** Part of each diff's React key, so a different comparison re-renders every diff. */
  version?: string;
  /** Whether a patch holding a whole file may render from both versions; only true for opencode's full-context diffs. */
  wholeFilePatches?: boolean;
  /** Loads a diff that didn't come with the others. */
  load?: (file: string) => Promise<string | undefined>;
  comments: ReviewComment[];
  open?: { file: string; anchor: LineAnchor };
  placeholder: string;
  onAnchor?: (file: string, anchor: LineAnchor) => void;
  /** These three must be stable: annotations may keep the first ones they were rendered with. */
  onAdd: (file: string, anchor: LineAnchor, text: string) => void;
  onCancel: () => void;
  onDelete: (id: string) => void;
}) => (
  <div
    className={cn(
      "grid items-start gap-4",
      !props.view.hideFiles &&
        "md:grid-cols-[minmax(14rem,22rem)_minmax(0,1fr)]"
    )}
  >
    {!props.view.hideFiles && (
      <Card className="sticky top-16 overflow-hidden py-0 max-md:static">
        <ChangedFilesTree
          files={props.files}
          onSelect={(file) => {
            const index = props.files.findIndex((f) => f.file === file);
            document
              .getElementById(`review-file-${index}`)
              ?.scrollIntoView({ block: "start" });
          }}
        />
      </Card>
    )}
    <div className="flex min-w-0 flex-col gap-3">
      {props.files.map((f, i) => (
        <FileDiff
          key={`${diffKey(f)}:${props.version ?? ""}`}
          id={`review-file-${i}`}
          file={f}
          load={
            props.load &&
            (() => props.load?.(f.file) ?? Promise.resolve(undefined))
          }
          view={props.view}
          wholeFilePatch={props.wholeFilePatches ?? false}
          comments={props.comments}
          open={props.open?.file === f.file ? props.open.anchor : undefined}
          placeholder={props.placeholder}
          onAnchor={
            props.onAnchor && ((anchor) => props.onAnchor?.(f.file, anchor))
          }
          onAdd={props.onAdd}
          onCancel={props.onCancel}
          onDelete={props.onDelete}
        />
      ))}
    </div>
  </div>
);

class DiffBoundary extends Component<
  { patch: string; children: ReactNode },
  { failed: boolean }
> {
  // oxlint-disable-next-line react/state-in-constructor
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="p-3">
        <Note warn>The renderer could not display this patch. Raw diff:</Note>
        <pre className="overflow-x-auto p-3 font-mono text-xs">
          {this.props.patch}
        </pre>
      </div>
    ) : (
      this.props.children
    );
  }
}

const Stats = ({ file }: { file: ReviewFile }) => (
  <span className="ml-auto font-mono text-xs whitespace-nowrap">
    <span className="text-ok">+{file.additions}</span>{" "}
    <span className="text-destructive">−{file.deletions}</span>
  </span>
);

const FileDiff = (props: {
  id: string;
  file: ReviewFile;
  load?: () => Promise<string | undefined>;
  view: DiffView;
  wholeFilePatch: boolean;
  comments: ReviewComment[];
  /** The line whose comment box is open in this file. */
  open: LineAnchor | undefined;
  placeholder: string;
  onAnchor?: (anchor: LineAnchor) => void;
  onAdd: (file: string, anchor: LineAnchor, text: string) => void;
  onCancel: () => void;
  onDelete: (id: string) => void;
}) => {
  const { file } = props;
  const [collapsed, setCollapsed] = useState(false);
  const [patch, setPatch] = useState(file.patch);
  const [loading, setLoading] = useState(false);
  // @pierre/diffs wants stable callbacks and annotations; these read the latest props.
  const onComment = useStableCallback((range: SelectedLineRange) => {
    if (patch !== undefined) {
      props.onAnchor?.(anchorFromRange(patch, range));
    }
  });
  const annotations = useMemo(
    () => annotationsFor(props.comments, file.file, props.open),
    [props.comments, file.file, props.open]
  );
  const selectedLines = useMemo(() => selectionFor(props.open), [props.open]);
  const renderAnnotation = useStableCallback(
    (a: DiffLineAnnotation<ReviewAnnotation>) => {
      if (a.metadata.kind === "draft") {
        const { anchor } = a.metadata;
        return (
          <CommentForm
            anchor={anchor}
            placeholder={props.placeholder}
            onAdd={(text) => props.onAdd(file.file, anchor, text)}
            onCancel={props.onCancel}
          />
        );
      }
      return (
        <div className="border-primary bg-card text-card-foreground mx-2 my-1 flex items-start gap-2 rounded-sm border-l-3 px-2.5 py-2 font-sans text-sm whitespace-pre-wrap">
          <span>
            {a.metadata.comment.start !== undefined && (
              <span className="text-muted-foreground">
                Lines {linesLabel(a.metadata.comment)}:{" "}
              </span>
            )}
            {a.metadata.comment.text}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground ml-auto"
            aria-label="Delete comment"
            onClick={() =>
              props.onDelete(
                a.metadata.kind === "comment" ? a.metadata.comment.id : ""
              )
            }
          >
            <XIcon />
          </Button>
        </div>
      );
    }
  );
  const toggle = useStableCallback(() => (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground inline-flex items-center pr-1"
      onClick={() => setCollapsed((c) => !c)}
      aria-expanded={!collapsed}
      title={collapsed ? "Show diff" : "Hide diff"}
    >
      {collapsed ? (
        <ChevronRightIcon className="size-3.5" />
      ) : (
        <ChevronDownIcon className="size-3.5" />
      )}
    </button>
  ));

  // A collapsed diff shows only its header: @pierre/diffs parses and highlights the whole patch even when
  // collapsed, which for a lockfile or a generated spec blocks the page for seconds.
  if (patch !== undefined && !file.binary && collapsed) {
    return (
      <Card
        className={cn("gap-0 overflow-hidden py-0", diffFont)}
        id={props.id}
      >
        <header className="bg-muted/50 flex items-center gap-2 px-3 py-1.5">
          {toggle()}
          <span className="min-w-0 truncate font-mono text-sm">
            {file.file}
          </span>
          <Stats file={file} />
        </header>
      </Card>
    );
  }
  if (patch !== undefined && !file.binary) {
    return (
      <Card className={cn("overflow-hidden py-0", diffFont)} id={props.id}>
        <DiffBoundary patch={patch}>
          <PatchView<ReviewAnnotation>
            patch={patch}
            name={props.wholeFilePatch ? file.file : undefined}
            split={props.view.split}
            fullFile={props.view.fullFile}
            onComment={props.onAnchor ? onComment : undefined}
            annotations={annotations}
            selectedLines={selectedLines}
            renderAnnotation={renderAnnotation}
            renderHeaderPrefix={toggle}
          />
        </DiffBoundary>
      </Card>
    );
  }
  const { load } = props;
  const pendingBody = loading ? (
    <DiffLinesSkeleton />
  ) : (
    <p className="flex items-center gap-3 px-3 py-2.5">
      {file.large && (
        <span className="text-muted-foreground text-sm">
          Large diff, not loaded with the others.
        </span>
      )}
      {load && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setLoading(true);
            void load()
              .then(setPatch)
              .finally(() => setLoading(false));
          }}
        >
          Load diff
        </Button>
      )}
    </p>
  );
  return (
    <Card className="gap-0 overflow-hidden py-0" id={props.id}>
      <header className="bg-muted/50 flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="font-mono text-sm">{file.file}</span>
        <Stats file={file} />
      </header>
      {file.binary ? (
        <p className="text-muted-foreground px-3 py-2.5 text-sm">binary</p>
      ) : (
        pendingBody
      )}
    </Card>
  );
};

/** The comment box inside the diff. Keeps its own text so typing doesn't re-render the whole diff. */
const CommentForm = (props: {
  anchor: LineAnchor;
  placeholder: string;
  onAdd: (text: string) => void;
  onCancel: () => void;
}) => {
  const [text, setText] = useState("");
  // The gutter button keeps focus through the click that opened this box, so focus it once that settles.
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  return (
    <form
      className="bg-card text-card-foreground mx-2 my-1 flex flex-col gap-2 rounded-md border p-2 font-sans text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) {
          props.onAdd(text.trim());
        }
      }}
    >
      {props.anchor.start !== undefined && (
        <span className="text-muted-foreground">
          Lines {linesLabel(props.anchor)}
        </span>
      )}
      <Textarea
        ref={input}
        className="min-h-0"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            props.onCancel();
          }
        }}
        placeholder={props.placeholder}
      />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={!text.trim()}>
          Add
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
};
