import { ChevronDownIcon } from "lucide-react";
import { Link } from "react-router";

import type { ForgejoPullDetails } from "../../shared/forgejo";
import { forgejoStackGraph } from "../forgejo";
import type { ForgejoStackRow } from "../forgejo";
import { useMediaQuery } from "../hooks/use-media-query";
import { cn } from "../lib/utils";
import { PanelSection } from "./Page";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";

/** Tailwind's `lg` breakpoint, from which the stack sits in the sidebar instead of above the conversation. */
const WIDE_QUERY = "(min-width: 64rem)";

/** Width of one column of the stack graph, in rem. */
const LANE_REM = 1.25;
/** Distance from the top of a row to the centre of its dot, lined up with the title's first line. */
const DOT_Y = "1.125rem";
/** Gap between a dot and the lines that meet it. */
const DOT_GAP = "0.4375rem";

const laneX = (lane: number) => `${(lane + 0.5) * LANE_REM}rem`;

/** One row's slice of the graph: the lines crossing it and the dot where its pull request sits. */
const StackRail = ({ row, lanes }: { row: ForgejoStackRow; lanes: number }) => (
  <span
    aria-hidden
    className="relative shrink-0 self-stretch"
    style={{ width: `${lanes * LANE_REM}rem` }}
  >
    {row.through.map((lane) => (
      <span
        key={lane}
        className="bg-muted-foreground/35 absolute inset-y-0 w-0.5 -translate-x-1/2"
        style={{ left: laneX(lane) }}
      />
    ))}
    {row.merges.map((lane) => (
      <span
        key={lane}
        className="border-muted-foreground/35 absolute top-0 rounded-br-lg border-r-2 border-b-2"
        style={{
          height: `calc(${DOT_Y} + 1px)`,
          left: `calc(${laneX(row.lane)} + ${DOT_GAP})`,
          width: `calc(${laneX(lane)} - ${laneX(row.lane)} - ${DOT_GAP} + 1px)`,
        }}
      />
    ))}
    {row.continues && (
      <span
        className="bg-muted-foreground/35 absolute top-0 w-0.5 -translate-x-1/2"
        style={{ height: `calc(${DOT_Y} - ${DOT_GAP})`, left: laneX(row.lane) }}
      />
    )}
    <span
      className="bg-muted-foreground/35 absolute bottom-0 w-0.5 -translate-x-1/2"
      style={{ left: laneX(row.lane), top: `calc(${DOT_Y} + ${DOT_GAP})` }}
    />
    <span
      className={cn(
        "absolute -translate-x-1/2 -translate-y-1/2 rounded-full",
        row.current
          ? "bg-primary ring-primary/20 size-3 ring-4"
          : "border-muted-foreground/70 size-2.5 border-2"
      )}
      style={{ left: laneX(row.lane), top: DOT_Y }}
    />
  </span>
);

const StackLabel = ({ row }: { row: ForgejoStackRow }) => (
  <span className="min-w-0 py-2">
    <span className="block break-words">
      <span className="text-muted-foreground tabular-nums">#{row.number}</span>{" "}
      <span className={cn(row.current && "font-semibold")}>{row.title}</span>
    </span>
    <code className="text-muted-foreground block truncate text-xs">
      {row.head}
    </code>
  </span>
);

/**
 * The open pull requests this one builds on and those built on it, drawn as a line
 * rising from the base branch, each linking to its own page.
 */
export const ForgejoStack = ({
  details,
  search,
}: {
  details: ForgejoPullDetails;
  /** The pull request list's filters, kept so "back" from a stacked pull request returns to the same view. */
  search: string;
}) => {
  const wide = useMediaQuery(WIDE_QUERY);
  const { rows, lanes } = forgejoStackGraph(details);
  if (!rows.length) {
    return null;
  }
  const { owner, repo } = details.pull;
  const bottom = details.stack?.ancestors[0]?.base ?? details.base;
  const position = rows.length - rows.findIndex((r) => r.current);
  const hint = `${position} of ${rows.length} on ${bottom}`;
  const rowClass = "flex gap-2 pr-4 pl-3 text-sm";
  const list = (
    <ol className="max-h-80 overflow-y-auto">
      {rows.map((row) => (
        <li key={row.number}>
          {row.current ? (
            <div aria-current="page" className={cn(rowClass, "bg-primary/5")}>
              <StackRail row={row} lanes={lanes} />
              <StackLabel row={row} />
            </div>
          ) : (
            <Link
              className={cn(
                rowClass,
                "hover:bg-muted focus-visible:ring-ring outline-none focus-visible:ring-2 focus-visible:ring-inset"
              )}
              to={`/forgejo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${row.number}${search ? `?${search}` : ""}`}
            >
              <StackRail row={row} lanes={lanes} />
              <StackLabel row={row} />
            </Link>
          )}
        </li>
      ))}
      <li className={cn(rowClass, "text-muted-foreground")}>
        <span
          aria-hidden
          className="relative h-8 shrink-0"
          style={{ width: `${lanes * LANE_REM}rem` }}
        >
          <span
            className="bg-muted-foreground/35 absolute top-0 w-0.5 -translate-x-1/2"
            style={{ height: "0.75rem", left: laneX(0) }}
          />
          <span
            className="bg-foreground absolute h-1 w-3.5 -translate-x-1/2 rounded-full"
            style={{ left: laneX(0), top: "0.75rem" }}
          />
        </span>
        <span className="self-center">
          <span className="sr-only">Base branch </span>
          <code className="text-xs">{bottom}</code>
        </span>
      </li>
    </ol>
  );
  if (wide) {
    return (
      <PanelSection title="Stack" hint={hint}>
        {list}
      </PanelSection>
    );
  }
  return (
    <Collapsible asChild>
      <section className="group/stack">
        <h2>
          <CollapsibleTrigger className="hover:bg-muted/50 focus-visible:ring-ring flex w-full items-baseline gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset">
            <span className="text-sm font-semibold">Stack</span>
            <span className="text-muted-foreground text-xs">{hint}</span>
            <ChevronDownIcon className="text-muted-foreground ml-auto size-4 shrink-0 self-center transition-transform group-data-[state=open]/stack:rotate-180 motion-reduce:transition-none" />
          </CollapsibleTrigger>
        </h2>
        <CollapsibleContent className="pb-2">{list}</CollapsibleContent>
      </section>
    </Collapsible>
  );
};
