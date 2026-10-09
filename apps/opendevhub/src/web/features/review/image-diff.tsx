import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type { ImageSide } from "../../../shared/images";
import type { ReviewFile } from "../../../shared/types";

/** Where to load one version of an image; undefined when this review can't show that version. */
export type ImageUrl = (file: string, side: ImageSide) => string | undefined;

/** Squares behind the image, so transparent pixels read as transparent in both themes. */
const checkerboard =
  "bg-[conic-gradient(var(--muted)_25%,transparent_0_50%,var(--muted)_0_75%,transparent_0)] bg-size-[16px_16px]";

const SIDES: { side: ImageSide; label: string; accent: string }[] = [
  { accent: "border-destructive/60", label: "Before", side: "old" },
  { accent: "border-ok/60", label: "After", side: "new" },
];

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
      <div
        className={cn(
          "flex min-h-24 items-center justify-center overflow-hidden rounded-md border-2 p-2",
          checkerboard,
          props.accent
        )}
      >
        {body}
      </div>
    </figure>
  );
};

/** A changed image as its before and after versions, side by side where there is room. */
export const ImageDiff = (props: {
  id: string;
  file: ReviewFile;
  imageUrl: ImageUrl;
}) => {
  const { file } = props;
  const [collapsed, setCollapsed] = useState(false);
  const sides = sidesOf(file.status);
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
          className="text-muted-foreground hover:text-foreground inline-flex items-center pr-1"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          title={collapsed ? "Show image" : "Hide image"}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
        </button>
        <span className="min-w-0 truncate font-mono text-sm">{file.file}</span>
        <span className="text-muted-foreground ml-auto text-xs whitespace-nowrap">
          {file.status} image
        </span>
      </header>
      {!collapsed && (
        <div
          className={cn("grid gap-3 p-3", sides.length > 1 && "sm:grid-cols-2")}
        >
          {sides.map(({ side, label, accent }) => (
            <ImagePane
              key={side}
              file={file.file}
              label={label}
              accent={accent}
              src={props.imageUrl(file.file, side)}
            />
          ))}
        </div>
      )}
    </Card>
  );
};
