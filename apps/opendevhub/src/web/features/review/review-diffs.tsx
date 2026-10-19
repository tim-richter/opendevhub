import { Button } from "@opendevhub/ui/button";
import { Card } from "@opendevhub/ui/card";
import { Checkbox } from "@opendevhub/ui/checkbox";
import { Textarea } from "@opendevhub/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@opendevhub/ui/toggle-group";
import { useStableCallback } from "@pierre/diffs/react";
import type {
  DiffLineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs/react";
import type { HotkeyCallback } from "@tanstack/react-hotkeys";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  Columns2Icon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  Rows2Icon,
  XIcon,
} from "lucide-react";
import {
  Component,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { useShortcut, useShortcutLabel } from "@/shell/use-shortcut";

import { imageType } from "../../../shared/images";
import type { ReviewFile } from "../../../shared/types";
import { Note, diffFont } from "../../components/page";
import { DiffLinesSkeleton } from "../../components/skeletons";
import { Tip } from "../../components/tip";
import { useMediaQuery } from "../../hooks/use-media-query";
import { ImageDiff } from "./image-diff";
import type { ImageUrl } from "./image-diff";
import { ChangedFilesTree } from "./lazy-changed-files-tree";
import { PatchView } from "./lazy-patch-view";
import {
  annotationsFor,
  anchorFromRange,
  diffKey,
  ensurePatchHeader,
  isViewed,
  linesLabel,
  selectionFor,
} from "./review";
import type {
  CommentStop,
  DiffNote,
  DiffView,
  LineAnchor,
  ReviewAnnotation,
  ReviewComment,
  ViewedFiles,
} from "./review";

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
        className="max-md:hidden"
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
    className="max-md:hidden"
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

/** The comment the stepper last jumped to; `at` tells two jumps to the same comment apart. */
export interface CommentFocus {
  stop: CommentStop;
  at: number;
}

/** How long a jump waits for a comment to render (its diff may still be parsing) before settling for its file. */
const SEEK_TIMEOUT_MS = 2000;
const DIFF_PRELOAD_MARGIN = "600px 0px";

const stopSelector = (id: string) => `[data-comment-stop="${CSS.escape(id)}"]`;

/** Steps through the comments in the diff in reading order, wrapping around at either end. */
export const useCommentStepper = (stops: CommentStop[]) => {
  const [focus, setFocus] = useState<CommentFocus>();
  const current = focus ? stops.findIndex((s) => s.id === focus.stop.id) : -1;
  const step = (delta: 1 | -1) => {
    if (!stops.length) {
      return;
    }
    let next = (current + delta + stops.length) % stops.length;
    if (current < 0) {
      // Nothing focused yet: start from the first comment below (or last above) the middle of the screen.
      const middle = window.innerHeight / 2;
      const below = (s: CommentStop) =>
        (document.querySelector(stopSelector(s.id))?.getBoundingClientRect()
          .top ?? -1) > middle;
      const first = stops.findIndex(below);
      if (delta > 0) {
        next = Math.max(first, 0);
      } else {
        next = (first === -1 ? stops.length : first) - 1;
        next = next < 0 ? stops.length - 1 : next;
      }
    }
    setFocus({ at: Date.now(), stop: stops[next] });
  };
  return { current, focus, step, total: stops.length };
};

/** In a dialog laid over the diff, such as the command palette, j and k belong to it. */
const inDialog = (target: EventTarget | null) =>
  !!(target as HTMLElement | null)?.closest?.("[role=dialog]");

/** "2 of 7 comments" with previous and next buttons; the Next and Previous comment shortcuts step too. */
export const CommentStepper = ({
  stepper,
}: {
  stepper: ReturnType<typeof useCommentStepper>;
}) => {
  const { current, step, total } = stepper;
  const stepBy =
    (by: 1 | -1): HotkeyCallback =>
    (e) => {
      if (!inDialog(e.target)) {
        e.preventDefault();
        step(by);
      }
    };
  const options = { preventDefault: false, stopPropagation: false };
  useShortcut("reviewNext", stepBy(1), options);
  useShortcut("reviewPrev", stepBy(-1), options);
  const nextKeys = useShortcutLabel("reviewNext");
  const prevKeys = useShortcutLabel("reviewPrev");
  if (!total) {
    return null;
  }
  return (
    // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
    <div className="flex items-center gap-1" role="group" aria-label="Comments">
      <Tip label={`Previous comment${prevKeys ? ` (${prevKeys})` : ""}`}>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Previous comment"
          onClick={() => step(-1)}
        >
          <ChevronUpIcon />
        </Button>
      </Tip>
      <Tip label={`Next comment${nextKeys ? ` (${nextKeys})` : ""}`}>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label="Next comment"
          onClick={() => step(1)}
        >
          <ChevronDownIcon />
        </Button>
      </Tip>
      <span className="px-1 text-sm tabular-nums" aria-live="polite">
        {current >= 0 ? `${current + 1} of ${total}` : total} comment
        {total === 1 ? "" : "s"}
      </span>
    </div>
  );
};

/** Scrolls to the focused comment once its diff has drawn it, and briefly outlines it. */
const useSeek = (focus: CommentFocus | undefined, files: ReviewFile[]) => {
  useEffect(() => {
    if (!focus) {
      return;
    }
    const index = files.findIndex((f) => f.file === focus.stop.file);
    const toFile = () =>
      document
        .getElementById(`review-file-${index}`)
        ?.scrollIntoView({ block: "start" });
    // A diff that isn't loaded can't show its comments; its file is as close as it gets.
    if (files[index]?.patch === undefined || files[index]?.binary) {
      toFile();
      return;
    }
    const deadline = performance.now() + SEEK_TIMEOUT_MS;
    let frame = 0;
    const seek = () => {
      const el = document.querySelector(stopSelector(focus.stop.id));
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.animate(
          [
            { outline: "2px solid var(--ring)" },
            { outline: "2px solid transparent" },
          ],
          { duration: 1600, easing: "ease-in" }
        );
      } else if (performance.now() > deadline) {
        toFile();
      } else {
        frame = requestAnimationFrame(seek);
      }
    };
    seek();
    return () => cancelAnimationFrame(frame);
  }, [focus, files]);
};

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
  /** Shows binary images as their before and after versions. */
  imageUrl?: ImageUrl;
  comments: ReviewComment[];
  /** Other people's comments or suggestions shown in the diff, drawn by `renderNote`. */
  notes?: DiffNote[];
  renderNote?: (id: string) => ReactNode;
  open?: { file: string; anchor: LineAnchor };
  placeholder: string;
  onAnchor?: (file: string, anchor: LineAnchor) => void;
  /** The comment to scroll to, from `useCommentStepper`. */
  focus?: CommentFocus;
  /** With `onViewed`, each diff has a Viewed checkbox; a viewed diff starts collapsed. */
  viewed?: ViewedFiles;
  onViewed?: (file: ReviewFile, viewed: boolean) => void;
  /** These three must be stable: annotations may keep the first ones they were rendered with. */
  onAdd: (file: string, anchor: LineAnchor, text: string) => void;
  onCancel: () => void;
  onDelete: (id: string) => void;
}) => {
  const phone = useMediaQuery("(max-width: 767px)");
  // Side-by-side diffs don't fit a phone.
  const view = phone ? { ...props.view, split: false } : props.view;
  useSeek(props.focus, props.files);
  const [selectedFile, setSelectedFile] = useState<string>();
  const selectedIndex = props.files.findIndex(
    (file) => file.file === selectedFile
  );
  useLayoutEffect(() => {
    if (selectedIndex === -1) {
      return;
    }
    const target = document.getElementById(`review-file-${selectedIndex}`);
    if (!target) {
      return;
    }
    const scroll = () => target.scrollIntoView({ block: "start" });
    scroll();
    // Lazy diffs can replace short placeholders after the jump. Watch the list so changes
    // in this file or earlier files cannot leave the selected header out of view.
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(scroll);
    observer.observe(target.parentElement ?? target);
    const timeout = window.setTimeout(
      () => observer.disconnect(),
      SEEK_TIMEOUT_MS
    );
    return () => {
      window.clearTimeout(timeout);
      observer.disconnect();
    };
  }, [selectedIndex]);
  const tree = (
    <ChangedFilesTree files={props.files} onSelect={setSelectedFile} />
  );
  return (
    <div
      className={cn(
        "grid items-start gap-4",
        !props.view.hideFiles &&
          "md:grid-cols-[minmax(14rem,22rem)_minmax(0,1fr)]"
      )}
    >
      {phone ? (
        <Card className="overflow-hidden py-0">
          <details>
            <summary className="cursor-pointer px-4 py-2.5 text-sm font-medium">
              {props.files.length} changed file
              {props.files.length === 1 ? "" : "s"}
            </summary>
            <div className="border-t">{tree}</div>
          </details>
        </Card>
      ) : (
        !props.view.hideFiles && (
          <Card className="sticky top-16 overflow-hidden py-0">{tree}</Card>
        )
      )}
      <div className="flex min-w-0 flex-col gap-3">
        {props.files.map((f, i) =>
          props.imageUrl && f.binary && imageType(f.file) ? (
            <ImageDiff
              key={`${diffKey(f)}:${props.version ?? ""}`}
              id={`review-file-${i}`}
              file={f}
              imageUrl={props.imageUrl}
            />
          ) : (
            <DeferredFileDiff
              key={`${diffKey(f)}:${props.version ?? ""}`}
              id={`review-file-${i}`}
              file={f}
              selected={selectedFile === f.file}
              viewed={props.viewed && isViewed(props.viewed, f)}
              onViewed={props.onViewed && ((on) => props.onViewed?.(f, on))}
              load={
                props.load &&
                (() => props.load?.(f.file) ?? Promise.resolve(undefined))
              }
              view={view}
              wholeFilePatch={props.wholeFilePatches ?? false}
              comments={props.comments}
              notes={props.notes}
              renderNote={props.renderNote}
              open={props.open?.file === f.file ? props.open.anchor : undefined}
              reveal={
                props.focus?.stop.file === f.file ? props.focus.at : undefined
              }
              placeholder={props.placeholder}
              onAnchor={
                props.onAnchor && ((anchor) => props.onAnchor?.(f.file, anchor))
              }
              onAdd={props.onAdd}
              onCancel={props.onCancel}
              onDelete={props.onDelete}
            />
          )
        )}
      </div>
    </div>
  );
};

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

/** Marks a diff as looked at; it unchecks itself once the file changes. */
const ViewedBox = (props: {
  viewed: boolean;
  onChange: (viewed: boolean) => void;
}) => {
  const id = useId();
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Checkbox
        id={id}
        checked={props.viewed}
        onCheckedChange={(v) => props.onChange(v === true)}
      />
      <label
        htmlFor={id}
        className="text-muted-foreground cursor-pointer font-sans text-xs whitespace-nowrap select-none"
      >
        Viewed
      </label>
    </span>
  );
};

interface FileDiffProps {
  id: string;
  file: ReviewFile;
  selected: boolean;
  /** Undefined when the review doesn't track viewed files. */
  viewed?: boolean;
  onViewed?: (viewed: boolean) => void;
  load?: () => Promise<string | undefined>;
  view: DiffView;
  wholeFilePatch: boolean;
  comments: ReviewComment[];
  notes?: DiffNote[];
  renderNote?: (id: string) => ReactNode;
  /** The line whose comment box is open in this file. */
  open: LineAnchor | undefined;
  /** Changes when the comment stepper jumps into this file, which expands it. */
  reveal: number | undefined;
  placeholder: string;
  onAnchor?: (anchor: LineAnchor) => void;
  onAdd: (file: string, anchor: LineAnchor, text: string) => void;
  onCancel: () => void;
  onDelete: (id: string) => void;
}

/** Keep the file list navigable while parsing and highlighting only diffs near the scroll area. */
const DeferredFileDiff = (props: FileDiffProps) => {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const ready =
    visible ||
    props.selected ||
    props.file.patch === undefined ||
    props.file.binary ||
    props.open !== undefined ||
    props.reveal !== undefined ||
    // Collapsed, so only its header renders.
    props.viewed === true;

  useEffect(() => {
    if (ready) {
      return;
    }
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: DIFF_PRELOAD_MARGIN }
    );
    if (host.current) {
      observer.observe(host.current);
    }
    return () => observer.disconnect();
  }, [ready]);

  return (
    <div id={props.id} ref={host} className="scroll-mt-16">
      {ready ? (
        <FileDiff {...props} />
      ) : (
        <Card className="min-h-40 gap-0 overflow-hidden py-0">
          <header className="bg-muted/50 flex items-center gap-2 px-3 py-1.5">
            <span className="min-w-0 truncate font-mono text-sm">
              {props.file.file}
            </span>
            <Stats file={props.file} />
            {props.onViewed && (
              <ViewedBox viewed={false} onChange={props.onViewed} />
            )}
          </header>
        </Card>
      )}
    </div>
  );
};

const FileDiff = (props: FileDiffProps) => {
  const { file } = props;
  const [collapsed, setCollapsed] = useState(props.viewed === true);
  const [revealed, setRevealed] = useState(props.reveal);
  if (props.reveal !== revealed) {
    setRevealed(props.reveal);
    if (props.reveal !== undefined) {
      setCollapsed(false);
    }
  }
  // Marking a diff viewed closes it; unmarking it, or the file changing since, opens it again.
  const [wasViewed, setWasViewed] = useState(props.viewed);
  if (props.viewed !== wasViewed) {
    setWasViewed(props.viewed);
    setCollapsed(props.viewed === true);
  }
  const [patch, setPatch] = useState(file.patch);
  const [loading, setLoading] = useState(false);
  // @pierre/diffs wants stable callbacks and annotations; these read the latest props.
  const onComment = useStableCallback((range: SelectedLineRange) => {
    if (patch !== undefined) {
      props.onAnchor?.(anchorFromRange(patch, range));
    }
  });
  const annotations = useMemo(
    () => annotationsFor(props.comments, file.file, props.open, props.notes),
    [props.comments, file.file, props.open, props.notes]
  );
  const selectedLines = useMemo(() => selectionFor(props.open), [props.open]);
  const renderAnnotation = useStableCallback(
    (a: DiffLineAnnotation<ReviewAnnotation>) => {
      if (a.metadata.kind === "note") {
        return (
          <div data-comment-stop={a.metadata.id} className="rounded-md">
            {props.renderNote?.(a.metadata.id)}
          </div>
        );
      }
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
        <div
          data-comment-stop={a.metadata.comment.id}
          className="border-primary bg-card text-card-foreground mx-2 my-1 flex items-start gap-2 rounded-sm border-l-3 px-2.5 py-2 font-sans text-sm whitespace-pre-wrap"
        >
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
  // These are called while rendering, where a stable callback would still see the previous render's state; they
  // change with what they draw instead.
  const toggle = useCallback(
    () => (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="h-auto w-auto p-0 pr-1 hover:bg-transparent"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        title={collapsed ? "Show diff" : "Hide diff"}
      >
        {collapsed ? (
          <ChevronRightIcon className="size-3.5" />
        ) : (
          <ChevronDownIcon className="size-3.5" />
        )}
      </Button>
    ),
    [collapsed]
  );
  const onViewed = useStableCallback((on: boolean) => props.onViewed?.(on));
  const tracksViewed = props.onViewed !== undefined;
  const viewed = props.viewed === true;
  const viewedBox = useCallback(
    () =>
      tracksViewed ? <ViewedBox viewed={viewed} onChange={onViewed} /> : null,
    [tracksViewed, viewed, onViewed]
  );

  // A collapsed diff shows only its header: @pierre/diffs parses and highlights the whole patch even when
  // collapsed, which for a lockfile or a generated spec blocks the page for seconds.
  if (patch !== undefined && !file.binary && collapsed) {
    return (
      <Card className={cn("gap-0 overflow-hidden py-0", diffFont)}>
        <header className="bg-muted/50 flex items-center gap-2 px-3 py-1.5">
          {toggle()}
          <span className="min-w-0 truncate font-mono text-sm">
            {file.file}
          </span>
          <Stats file={file} />
          {viewedBox()}
        </header>
      </Card>
    );
  }
  if (patch !== undefined && !file.binary) {
    return (
      <Card className={cn("overflow-hidden py-0", diffFont)}>
        <DiffBoundary patch={patch}>
          <PatchView<ReviewAnnotation>
            patch={ensurePatchHeader(patch, file.file)}
            name={props.wholeFilePatch ? file.file : undefined}
            split={props.view.split}
            fullFile={props.view.fullFile}
            onComment={props.onAnchor ? onComment : undefined}
            annotations={annotations}
            selectedLines={selectedLines}
            renderAnnotation={renderAnnotation}
            renderHeaderPrefix={toggle}
            renderHeaderMetadata={tracksViewed ? viewedBox : undefined}
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
    <Card className="gap-0 overflow-hidden py-0">
      <header className="bg-muted/50 flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="font-mono text-sm">{file.file}</span>
        <Stats file={file} />
        {viewedBox()}
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
  useShortcut("reviewCancel", () => props.onCancel(), {
    ignoreInputs: false,
    target: input,
  });
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
