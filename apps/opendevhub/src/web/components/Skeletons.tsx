import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Placeholder line widths, so the skeletons read as code rather than as a block.
const widths = ["w-3/4", "w-1/2", "w-5/6", "w-2/3", "w-1/3", "w-4/5", "w-3/5"];

/** Lines of a diff that hasn't arrived yet. */
export const DiffLinesSkeleton = ({ lines = 6 }: { lines?: number }) => (
  <div className="flex flex-col gap-2 px-3 py-3" aria-hidden>
    {Array.from({ length: lines }, (_, i) => (
      <Skeleton key={i} className={`h-3.5 ${widths[i % widths.length]}`} />
    ))}
  </div>
);

/** A file's diff card while it loads: a header row and a few lines. */
export const FileDiffSkeleton = ({ lines }: { lines?: number }) => (
  <Card className="gap-0 overflow-hidden py-0" aria-hidden>
    <div className="bg-muted/50 flex items-center justify-between gap-2 border-b px-3 py-2">
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-4 w-14" />
    </div>
    <DiffLinesSkeleton lines={lines} />
  </Card>
);

/** The changed-files tree while it loads. */
export const FilesTreeSkeleton = ({ rows = 6 }: { rows?: number }) => (
  <div className="flex flex-col gap-2.5 px-3 py-3" aria-hidden>
    {Array.from({ length: rows }, (_, i) => (
      <div
        key={i}
        className={`flex items-center gap-2 ${i % 3 === 0 ? "" : "pl-4"}`}
      >
        <Skeleton className="size-3.5 shrink-0" />
        <Skeleton className={`h-3.5 ${widths[(i + 2) % widths.length]}`} />
      </div>
    ))}
  </div>
);

/** The Review tab's file list and diffs before the first load answers. */
export const ReviewSkeleton = () => (
  <div
    className="grid items-start gap-4 md:grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]"
    role="status"
    aria-label="Loading changes"
  >
    <Card className="overflow-hidden py-0">
      <FilesTreeSkeleton />
    </Card>
    <div className="flex min-w-0 flex-col gap-3">
      <FileDiffSkeleton lines={8} />
      <FileDiffSkeleton lines={4} />
      <FileDiffSkeleton lines={6} />
    </div>
  </div>
);
