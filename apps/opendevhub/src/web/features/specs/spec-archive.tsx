import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { archiveSpec } from "../../api";
import { muted } from "../../components/page";
import { reviewKey } from "../review/review-queries";
import { specKey } from "./spec-queries";

/**
 * Archives the implemented change with the OpenSpec CLI, no agent turn: its delta specs go into `openspec/specs/`
 * and the change moves to `openspec/changes/archive/`, on the same branch as the code.
 */
export const ArchiveSpec = (props: {
  projectId: string;
  directory: string;
  change: string;
  busy: boolean;
}) => {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string>();
  const archive = useMutation({
    mutationFn: () =>
      archiveSpec(props.projectId, {
        change: props.change,
        directory: props.directory,
      }),
    onMutate: () => setNotice(undefined),
    onSuccess: async () => {
      setNotice("Archived; openspec/specs/ now has the change.");
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: specKey(props.projectId, props.directory),
        }),
        queryClient.invalidateQueries({
          queryKey: reviewKey(props.projectId, props.directory),
        }),
      ]);
    },
  });
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={props.busy || archive.isPending}
          onClick={() => archive.mutate()}
        >
          {archive.isPending ? "Archiving…" : "Archive"}
        </Button>
        {props.busy ? (
          <span className={muted}>
            The agent is working; archive when its turn ends.
          </span>
        ) : (
          !notice && (
            <span className={muted}>
              Every task is done. Archiving merges the change&apos;s specs into
              openspec/specs/ and moves it to openspec/changes/archive/.
            </span>
          )
        )}
        {archive.error && (
          <span className="text-destructive">{archive.error.message}</span>
        )}
        {notice && <span className="text-ok">{notice}</span>}
      </div>
    </div>
  );
};
