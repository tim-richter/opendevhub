import { DifferenceMode, OnionSkinMode, SwipeMode } from "@blazediff/react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Card } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import type { ImageSide } from "../../../shared/images";
import type { ReviewFile } from "../../../shared/types";

/** Where to load one version of an image; undefined when this review can't show that version. */
export type ImageUrl = (file: string, side: ImageSide) => string | undefined;

/** Squares behind the image, so transparent pixels read as transparent in both themes. */
const checkerboard =
  "bg-[conic-gradient(var(--muted)_25%,transparent_0_50%,var(--muted)_0_75%,transparent_0)] bg-size-[16px_16px]";

/** The frame every view draws its images in. */
const frame = cn(
  "flex min-h-24 items-center justify-center overflow-hidden rounded-md border-2 p-2",
  checkerboard
);

const SIDES: { side: ImageSide; label: string; accent: string }[] = [
  { accent: "border-destructive/60", label: "Before", side: "old" },
  { accent: "border-ok/60", label: "After", side: "new" },
];

/** How a modified image is compared; remembered across reviews and reloads. */
type CompareMode = "two-up" | "swipe" | "onion" | "difference";

const MODES: { mode: CompareMode; label: string; title: string }[] = [
  { label: "2-up", mode: "two-up", title: "Before and after side by side" },
  {
    label: "Swipe",
    mode: "swipe",
    title: "Drag a divider across both versions",
  },
  {
    label: "Onion skin",
    mode: "onion",
    title: "Fade the after version over the before",
  },
  {
    label: "Difference",
    mode: "difference",
    title: "Highlight the pixels that changed",
  },
];

const MODE_KEY = "opendevhub:image-diff-mode";

const readMode = (): CompareMode => {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return MODES.find((m) => m.mode === stored)?.mode ?? "two-up";
  } catch {
    return "two-up";
  }
};

const saveMode = (mode: CompareMode) => {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* Storage may be disabled. */
  }
};

/** The versions a change has: an added image has no before, a deleted one no after. */
const sidesOf = (status: ReviewFile["status"]) =>
  SIDES.filter(
    ({ side }) =>
      !(
        (status === "added" && side === "old") ||
        (status === "deleted" && side === "new")
      )
  );

const ImagePane = (props: {
  file: string;
  label: string;
  accent: string;
  src: string | undefined;
}) => {
  const [size, setSize] = useState<{ width: number; height: number }>();
  const [failed, setFailed] = useState(false);
  let body = (
    <img
      src={props.src}
      alt={`${props.label}: ${props.file}`}
      loading="lazy"
      className="max-h-112 max-w-full object-contain"
      onLoad={(e) =>
        setSize({
          height: e.currentTarget.naturalHeight,
          width: e.currentTarget.naturalWidth,
        })
      }
      onError={() => setFailed(true)}
    />
  );
  if (!props.src || failed) {
    body = (
      <span className="text-muted-foreground px-3 text-sm">
        {props.src
          ? "Could not load this version."
          : "This version isn't available here."}
      </span>
    );
  }
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <figcaption className="text-muted-foreground flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium">{props.label}</span>
        {size && (
          <span className="font-mono">
            {size.width} × {size.height}
          </span>
        )}
      </figcaption>
      <div className={cn(frame, props.accent)}>{body}</div>
    </figure>
  );
};

const TwoUp = (props: {
  file: string;
  srcOf: (side: ImageSide) => string | undefined;
  sides: typeof SIDES;
}) => (
  <div className={cn("grid gap-3", props.sides.length > 1 && "sm:grid-cols-2")}>
    {props.sides.map(({ side, label, accent }) => (
      <ImagePane
        key={side}
        file={props.file}
        label={label}
        accent={accent}
        src={props.srcOf(side)}
      />
    ))}
  </div>
);

/** The pixel diff of two versions; only computed while this view is shown. */
const Difference = (props: { before: string; after: string }) => {
  const [result, setResult] = useState<string>();
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-muted-foreground text-xs">
        {result ?? "Comparing pixels…"}
      </p>
      <DifferenceMode
        src1={props.before}
        src2={props.after}
        containerClassName={frame}
        canvasClassName="max-h-112 max-w-full object-contain"
        onDiffComplete={({ diffCount, percentage }) =>
          setResult(
            diffCount === 0
              ? "No pixels changed."
              : `${diffCount.toLocaleString()} pixels changed (${percentage.toFixed(2)}%).`
          )
        }
        onDiffError={(error) =>
          setResult(
            `Could not compare the pixels: ${error instanceof Error ? error.message : "the images didn't load"}.`
          )
        }
      />
    </div>
  );
};

/** Before and after of a modified image, shown the way `mode` compares them. */
const Comparison = (props: {
  mode: CompareMode;
  file: string;
  before: string;
  after: string;
}) => {
  if (props.mode === "swipe") {
    return (
      <div className={frame}>
        <SwipeMode
          src1={props.before}
          src2={props.after}
          alt1={`Before: ${props.file}`}
          alt2={`After: ${props.file}`}
          className="max-w-full"
          containerClassName="w-fit max-w-full"
          image1ClassName="max-h-112"
          dividerClassName="shadow-[0_0_0_1px_rgb(0_0_0/0.5)]"
        />
      </div>
    );
  }
  if (props.mode === "onion") {
    return (
      <OnionSkinMode
        src1={props.before}
        src2={props.after}
        containerClassName="flex flex-col gap-2"
        imageContainerClassName={cn(
          frame,
          "[&>img:last-child]:size-full [&>img:last-child]:object-contain"
        )}
        imageClassName="max-h-112 max-w-full"
        sliderContainerClassName="text-muted-foreground flex items-center gap-3 text-xs"
        sliderLabelClassName="whitespace-nowrap"
        sliderLabelText="Before ⇄ After"
        sliderClassName="accent-primary w-full max-w-64"
      />
    );
  }
  return <Difference before={props.before} after={props.after} />;
};

/** A changed image as its before and after versions; a modified one starts collapsed and loads only once opened. */
export const ImageDiff = (props: {
  id: string;
  file: ReviewFile;
  imageUrl: ImageUrl;
}) => {
  const { file } = props;
  const [collapsed, setCollapsed] = useState(file.status === "modified");
  const [mode, setMode] = useState(readMode);
  const sides = sidesOf(file.status);
  const srcOf = (side: ImageSide) => props.imageUrl(file.file, side);
  const before = srcOf("old");
  const after = srcOf("new");
  // The overlaid views need both versions; anything else stays side by side.
  const comparable = sides.length > 1 && before && after;
  let body = <TwoUp file={file.file} srcOf={srcOf} sides={sides} />;
  if (comparable && mode !== "two-up") {
    body = (
      <Comparison mode={mode} file={file.file} before={before} after={after} />
    );
  }
  return (
    <Card className="gap-0 overflow-hidden py-0" id={props.id}>
      <header
        className={cn(
          "bg-muted/50 flex items-center gap-2 px-3 py-1.5",
          !collapsed && "border-b"
        )}
      >
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex min-w-0 items-center gap-2 text-left"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          title={collapsed ? "Show image" : "Hide image"}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5 shrink-0" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0" />
          )}
          <span className="text-foreground min-w-0 truncate font-mono text-sm">
            {file.file}
          </span>
        </button>
        <span className="text-muted-foreground ml-auto text-xs whitespace-nowrap">
          {file.status} image
        </span>
      </header>
      {!collapsed && (
        <div className="flex flex-col gap-3 p-3">
          {comparable && (
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              aria-label="Compare images"
              className="max-w-full flex-wrap"
              value={mode}
              onValueChange={(value) => {
                const next = MODES.find((m) => m.mode === value)?.mode;
                if (next) {
                  setMode(next);
                  saveMode(next);
                }
              }}
            >
              {MODES.map((m) => (
                <ToggleGroupItem key={m.mode} value={m.mode} title={m.title}>
                  {m.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
          {body}
        </div>
      )}
    </Card>
  );
};
