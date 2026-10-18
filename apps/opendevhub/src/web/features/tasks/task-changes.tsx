import { Button } from "@opendevhub/ui/button";
import { Card } from "@opendevhub/ui/card";
import { Skeleton } from "@opendevhub/ui/skeleton";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import type { ReviewFile, ReviewMode } from "../../../shared/types";
import { fetchReview } from "../../api";
import { diffFont, Empty, muted, Note, Segmented } from "../../components/page";
import { DiffLinesSkeleton } from "../../components/skeletons";
import { workspaceFolderOf } from "../../derive";
import { Link, useSearchParams } from "../../routing";
import { useCheckoutContext } from "../checkouts/checkout-context";
import { PatchView } from "../review/lazy-patch-view";
import { reviewKey, reviewQuery } from "../review/review-queries";
import { VariantCheckout } from "./task-checkout-tabs";
import { useTaskPage } from "./task-context";
import { reviewHref } from "./task-status";

type DiffMode = Extract<ReviewMode, "working" | "branch">;

const STATUS_LETTER: Record<ReviewFile["status"], string> = {
  added: "A",
  deleted: "D",
  modified: "M",
};

const STATUS_TONE: Record<ReviewFile["status"], string> = {
  added: "text-ok",
  deleted: "text-destructive",
  modified: "text-warn",
};

const STATUS_LABEL: Record<ReviewFile["status"], string> = {
  added: "added",
  deleted: "deleted",
  modified: "modified",
};

/** One file's diff: the patch sent with the list, or loaded on its own when it wasn't (large, binary, over budget). */
const FileDiff = (props: {
  projectId: string;
  directory: string;
  mode: DiffMode;
  file: ReviewFile;
}) => {
  const { projectId, directory, mode, file } = props;
  const missing = file.patch === undefined && !file.binary;
  const loaded = useQuery({
    enabled: missing,
    queryFn: ({ signal }) =>
      fetchReview(projectId, directory, { file: file.file, mode }, signal),
    // Under the checkout's review key, so a refresh of its changes reloads it too.
    queryKey: [...reviewKey(projectId, directory), { file: file.file, mode }],
  });
  const patch = file.patch ?? loaded.data?.files[0]?.patch;
  if (file.binary) {
    return (
      <p className={muted}>A binary file; its diff can&apos;t be shown.</p>
    );
  }
  if (loaded.error) {
    return <p className="text-destructive text-sm">{loaded.error.message}</p>;
  }
  if (!patch) {
    return missing && loaded.isFetching ? (
      <DiffLinesSkeleton />
    ) : (
      <p className={muted}>No changes to show.</p>
    );
  }
  return (
    <div className={cn("min-w-0", diffFont)}>
      <PatchView patch={patch} name={file.file} />
    </div>
  );
};

const ChangesBody = () => {
  const { view, checkout } = useCheckoutContext();
  const { task, variant } = useTaskPage();
  const [params, setParams] = useSearchParams();
  const projectId = view.project.id;
  const { directory } = checkout;
  const [mode, setMode] = useState<DiffMode>(
    checkout.worktree ? "branch" : "working"
  );
  const working = useQuery(
    reviewQuery(projectId, directory, { mode: "working" })
  );
  const branch = useQuery({
    ...reviewQuery(projectId, directory, { mode: "branch" }),
    enabled: !!checkout.worktree,
  });
  const list = useQuery({
    ...reviewQuery(projectId, directory, { mode }),
    placeholderData: keepPreviousData,
  });
  const files = list.data?.files ?? [];
  const selectedName = params.get("file");
  const selected = files.find((f) => f.file === selectedName);

  // A file that left the list (switched to Uncommitted, or committed) is no longer selected.
  const gone =
    !!selectedName && !!list.data && !list.isPlaceholderData && !selected;
  useEffect(() => {
    if (gone) {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          out.delete("file");
          return out;
        },
        { replace: true }
      );
    }
  }, [gone, setParams]);

  const select = (file: string) =>
    setParams((prev) => {
      const out = new URLSearchParams(prev);
      out.set("file", file);
      return out;
    });

  const count = (q: typeof working) =>
    q.data ? ` · ${q.data.files.length}` : "";
  const base = branch.data?.base?.name ?? working.data?.base?.name ?? "base";

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {checkout.worktree ? (
          <Segmented
            label="Compare"
            value={mode}
            options={[
              { id: "working", label: `Uncommitted${count(working)}` },
              { id: "branch", label: `vs ${base}${count(branch)}` },
            ]}
            onChange={setMode}
          />
        ) : (
          <span className={muted}>Uncommitted{count(working)}</span>
        )}
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <Link to={reviewHref(view, task, variant)}>
            Review changes <ArrowRightIcon />
          </Link>
        </Button>
      </div>
      {list.error && (
        <p className="text-destructive text-sm">{list.error.message}</p>
      )}
      {!list.data && !list.error && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      )}
      {list.data && files.length === 0 && (
        <Empty title="No changes">
          <p className={muted}>
            {mode === "working"
              ? "Nothing uncommitted."
              : `Nothing differs from ${base}.`}
          </p>
        </Empty>
      )}
      {files.length > 0 && (
        <Card className="gap-0 py-0">
          <ul aria-label="Changed files" className="divide-y">
            {files.map((f) => {
              const active = f.file === selected?.file;
              return (
                <li key={f.file}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => select(f.file)}
                    className={cn(
                      "flex min-h-10 w-full min-w-0 items-center gap-3 px-3 py-1.5 text-left text-sm",
                      active ? "bg-accent" : "hover:bg-accent/50"
                    )}
                  >
                    <span
                      className={cn(
                        "w-3 shrink-0 font-mono text-xs font-semibold",
                        STATUS_TONE[f.status]
                      )}
                      title={STATUS_LABEL[f.status]}
                    >
                      {STATUS_LETTER[f.status]}
                      <span className="sr-only">
                        {" "}
                        ({STATUS_LABEL[f.status]})
                      </span>
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate font-mono text-xs"
                      title={f.file}
                    >
                      {f.file}
                    </span>
                    {f.large && (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        large
                      </span>
                    )}
                    <span className="shrink-0 font-mono text-xs tabular-nums">
                      <span className="text-ok">+{f.additions}</span>{" "}
                      <span className="text-destructive">−{f.deletions}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {selected && (
        <section aria-label={`Diff of ${selected.file}`} className="min-w-0">
          <FileDiff
            key={`${mode}:${selected.file}`}
            projectId={projectId}
            directory={directory}
            mode={mode}
            file={selected}
          />
        </section>
      )}
    </div>
  );
};

/**
 * The Changes tab: the selected variant's changed files, then one file's diff once picked (`?file=`). Publishing,
 * merging, AI review and comments are on the Review page; a workspace task's changes are the main checkout's.
 */
export const TaskChanges = () => {
  const { view, variant } = useTaskPage();
  const shared =
    !!variant.directory && variant.directory === workspaceFolderOf(view);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
      {shared && (
        <Note>
          This task works in the main checkout, so these are the main
          checkout&apos;s changes, shared with the other conversations there.
        </Note>
      )}
      <VariantCheckout>
        <ChangesBody />
      </VariantCheckout>
    </div>
  );
};
