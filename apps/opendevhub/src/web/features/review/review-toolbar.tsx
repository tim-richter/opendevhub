import { Button } from "@opendevhub/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@opendevhub/ui/dropdown-menu";
import { Skeleton } from "@opendevhub/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@opendevhub/ui/toggle-group";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  GitBranchIcon,
  GitCompareArrowsIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import type { ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";

import type { ReviewData, ReviewMode } from "../../../shared/types";
import { Tip } from "../../components/tip";
import type { DiffView } from "./review";
import { checkedItem } from "./review-diffs";

/** How the diffs are drawn: lines shown, layout and the file list. Kept out of the way of what you do with them. */
const ViewMenu = (props: {
  view: DiffView;
  onChange: (change: Partial<DiffView>) => void;
}) => {
  const { view, onChange } = props;
  return (
    <DropdownMenu>
      <Tip label="How diffs are shown">
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <SlidersHorizontalIcon aria-hidden />{" "}
            <span className="max-sm:sr-only">View</span> <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Lines</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.fullFile ? "full" : "changes"}
          onValueChange={(v) => onChange({ fullFile: v === "full" })}
        >
          <DropdownMenuRadioItem value="changes">
            Changes only
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="full">Full file</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Layout</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={view.split ? "split" : "unified"}
          onValueChange={(v) => onChange({ split: v === "split" })}
        >
          <DropdownMenuRadioItem value="unified">Unified</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="split" className="max-md:hidden">
            Side by side
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={!view.hideFiles}
          onCheckedChange={(on) => onChange({ hideFiles: !on })}
          className="max-md:hidden"
        >
          Show file list
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

/**
 * One slim row: where you are (branch, what it is compared with), then the tools for looking at the diff. What to do
 * with the changes lives in the sidebar's step panel; what to do with the branch, on its name.
 */
export const ReviewToolbar = (props: {
  barRef: Ref<HTMLDivElement>;
  data?: ReviewData;
  /** Shown instead of the branch while the review loads or has failed. */
  hasError: boolean;
  base: string;
  busy?: string;
  loading: boolean;
  view: DiffView;
  onView: (change: Partial<DiffView>) => void;
  onMode: (mode: ReviewMode) => void;
  onPickBase: () => void;
  onRefresh: () => void;
  /** AI review, checks and other tools for the diff. */
  tools: ReactNode;
  /** Entries of the menu on the branch name, such as making a new branch. */
  branchItems: ReactNode;
}) => {
  const { data, base } = props;
  return (
    <div
      ref={props.barRef}
      className="bg-background/95 sticky top-[var(--review-bar-top,0px)] z-20 -mx-[var(--review-gutter,1rem)] flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-[var(--review-gutter,1rem)] py-2 backdrop-blur max-md:top-[var(--review-bar-top,45px)] md:-mx-[var(--review-gutter,2rem)] md:px-[var(--review-gutter,2rem)]"
    >
      {!data && !props.hasError && <Skeleton className="h-5 w-48" />}
      {data && (
        <div className="contents text-sm">
          <DropdownMenu>
            <Tip label="Current branch">
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="-ml-2 min-w-0 font-medium"
                >
                  <GitBranchIcon className="text-muted-foreground" />
                  <span className="truncate">
                    {data.branch ?? "detached HEAD"}
                  </span>
                  <ChevronDownIcon className="text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
            </Tip>
            <DropdownMenuContent align="start" className="w-64">
              {props.branchItems}
            </DropdownMenuContent>
          </DropdownMenu>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            aria-label="Changes shown"
            value={data.mode}
            onValueChange={(v) => v && props.onMode(v as ReviewMode)}
          >
            <Tip label="Uncommitted changes: what you haven't committed yet">
              <ToggleGroupItem
                className={cn(checkedItem, "font-normal")}
                value="working"
              >
                Uncommitted
              </ToggleGroupItem>
            </Tip>
            <Tip
              label={
                data.base
                  ? `Everything since ${base} (from ${data.base.source}), committed or not.${data.mode === "branch" ? " Click to change the base." : ""}`
                  : "No base branch to compare with"
              }
            >
              <ToggleGroupItem
                className={cn(checkedItem, "font-normal")}
                value="branch"
                aria-label={`Compare with ${base}`}
                disabled={!data.base}
                onClick={() => data.mode === "branch" && props.onPickBase()}
              >
                <GitCompareArrowsIcon /> vs {base}
              </ToggleGroupItem>
            </Tip>
          </ToggleGroup>
          <Tip
            label={`${data.ahead} commit${data.ahead === 1 ? "" : "s"} ahead of ${base}, ${data.behind} behind`}
          >
            <span className="text-muted-foreground inline-flex items-center gap-1.5 tabular-nums">
              <span className="inline-flex items-center">
                <ArrowUpIcon className="size-3.5" />
                {data.ahead}
              </span>
              <span className="inline-flex items-center">
                <ArrowDownIcon className="size-3.5" />
                {data.behind}
              </span>
            </span>
          </Tip>
          {props.busy && (
            <span className="text-muted-foreground inline-flex items-center gap-1">
              <LoaderCircleIcon className="size-3.5 animate-spin" />{" "}
              {props.busy}…
            </span>
          )}
        </div>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <ViewMenu view={props.view} onChange={props.onView} />
        {props.tools}
        <Tip label="Refresh">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Refresh"
            disabled={props.loading}
            onClick={props.onRefresh}
          >
            <RefreshCwIcon className={cn(props.loading && "animate-spin")} />
          </Button>
        </Tip>
      </div>
    </div>
  );
};
