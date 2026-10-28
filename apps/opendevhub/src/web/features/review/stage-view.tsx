import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";

import { commitStaged, stageChanges } from "../../api";
import { Note, muted } from "../../components/page";
import { DiffLinesSkeleton } from "../../components/skeletons";
import type { StageChange } from "./hunk-controls";
import { ReviewDiffs } from "./review-diffs";
import { refreshCheckout, stageQuery } from "./review-queries";
import { hunkCount, optimisticStage } from "./stage";
import type { Selection } from "./stage";

/**
 * What is kept (in the index) and what is still only in the working tree, with the actions on them. Clicks are
 * answered at once and sent one after the other: a hunk's number is its place among the hunks left, so the server
 * must see them in the order they were made.
 */
export const useStage = (
  projectId: string,
  directory: string,
  enabled: boolean
) => {
  const queryClient = useQueryClient();
  const query = stageQuery(projectId, directory);
  const stage = useQuery({ ...query, enabled });
  const commit = useMutation({
    mutationFn: (message: string) =>
      commitStaged(projectId, directory, message),
    onSettled: () => refreshCheckout(queryClient, projectId, directory),
  });
  const [failure, setFailure] = useState<Error>();
  const queue = useRef(Promise.resolve());
  const inFlight = useRef(0);
  const change = useCallback<StageChange>(
    (action, target) => {
      setFailure(undefined);
      void queryClient.cancelQueries({ queryKey: query.queryKey });
      queryClient.setQueryData(query.queryKey, (data) =>
        data ? optimisticStage(data, action, target) : data
      );
      inFlight.current += 1;
      const previous = queue.current;
      queue.current = (async () => {
        await previous;
        try {
          const next = await stageChanges(projectId, directory, {
            action,
            ...target,
          });
          // While more clicks wait, their picture is ahead of this answer.
          if (inFlight.current === 1) {
            queryClient.setQueryData(query.queryKey, next);
          }
        } catch (error) {
          setFailure(error instanceof Error ? error : new Error(String(error)));
          await queryClient.invalidateQueries({ queryKey: query.queryKey });
        } finally {
          inFlight.current -= 1;
          if (inFlight.current === 0) {
            void refreshCheckout(queryClient, projectId, directory, true);
          }
        }
      })();
    },
    [queryClient, query.queryKey, projectId, directory]
  );
  const { data } = stage;
  return {
    busy: commit.isPending,
    change,
    commit: (message: string) => commit.mutateAsync(message),
    data,
    error: failure ?? commit.error ?? stage.error ?? undefined,
    /** Hunks waiting for a decision, and hunks kept for the next commit. */
    left: data ? hunkCount(data.unstaged) : undefined,
    kept: data ? hunkCount(data.staged) : undefined,
  };
};

export type Stage = ReturnType<typeof useStage>;

/** What the diff lists share with the branch view: the same props, minus what the stage sections set themselves. */
export type DiffListProps = Omit<
  ComponentProps<typeof ReviewDiffs>,
  "files" | "hunks" | "hideTree" | "selectedFile" | "idPrefix"
>;

/**
 * The selected file's diff, one at a time. A file still waiting for a decision can be kept or undone hunk by hunk
 * and commented on for the agent; a staged one can be unstaged. The commit is made from the sidebar.
 */
export const ChangeSections = (props: {
  stage: Stage;
  diffProps: DiffListProps;
  selection?: Selection;
}) => {
  const { stage, diffProps, selection } = props;
  const { data, busy, change } = stage;
  const controls = useMemo(
    () => ({ change, disabled: busy, staged: selection?.staged ?? false }),
    [change, busy, selection?.staged]
  );
  if (!data) {
    return stage.error ? (
      <Note error>{stage.error.message}</Note>
    ) : (
      <DiffLinesSkeleton />
    );
  }
  const file = (selection?.staged ? data.staged : data.unstaged).find(
    (f) => f.file === selection?.file
  );
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {stage.error && <Note error>{stage.error.message}</Note>}
      {!file && (
        <p className={muted}>
          {data.unstaged.length + data.staged.length === 0
            ? "No uncommitted changes."
            : "Select a file to see its changes."}
        </p>
      )}
      {file && (
        <ReviewDiffs
          // A new file starts with fresh diff state.
          key={`${selection?.staged}:${file.file}`}
          {...diffProps}
          files={[file]}
          hideTree
          collapsible={false}
          idPrefix="review-file"
          hunks={controls}
          {...(selection?.staged
            ? {
                comments: [],
                notes: undefined,
                onAnchor: undefined,
                open: undefined,
              }
            : {})}
        />
      )}
    </div>
  );
};
