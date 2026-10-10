import { useMutation, useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";

import { confirm } from "@/components/confirm-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { SpecChange } from "../../../shared/types";
import { approveSpec } from "../../api";
import { muted } from "../../components/page";
import { specKey } from "./spec-queries";
import { approveBlocker, approveWarnings } from "./specs";

/** How far the agent is through the change's tasks. */
export const TaskProgress = (props: {
  completed: number;
  total: number;
  className?: string;
}) => {
  const { completed, total } = props;
  const percent = Math.round((completed / total) * 100);
  return (
    <span className={cn("inline-flex items-center gap-2", props.className)}>
      <span
        role="progressbar"
        aria-label="Tasks done"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={completed}
        className="bg-muted h-1.5 w-24 overflow-hidden rounded-full"
      >
        <span
          className="bg-ok block h-full rounded-full transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </span>
      <span className="text-muted-foreground text-xs tabular-nums">
        {completed}/{total} tasks
      </span>
    </span>
  );
};

/**
 * The strict gate: approving the proposed change is the only way its task starts implementing. Code the agent wrote
 * before approval, or a change that doesn't validate, has to be confirmed first.
 */
export const ApproveSpec = (props: {
  projectId: string;
  directory: string;
  change: SpecChange;
  busy: boolean;
  /** Files changed outside `openspec/`; undefined while the checkout's changes load. */
  code?: string[];
}) => {
  const { change, code = [] } = props;
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string>();
  const approve = useMutation({
    mutationFn: (force: boolean) =>
      approveSpec(props.projectId, {
        change: change.name,
        directory: props.directory,
        force,
      }),
    onMutate: () => setNotice(undefined),
    onSuccess: async () => {
      setNotice("Approved; the agent is implementing it with /opsx-apply.");
      await queryClient.invalidateQueries({
        queryKey: specKey(props.projectId, props.directory),
      });
    },
  });
  const blocker = approveBlocker(change, props.busy);
  const onApprove = async () => {
    const warnings = approveWarnings(change, code);
    if (warnings.length > 0) {
      const ok = await confirm({
        confirmLabel: "Approve anyway",
        description: `${warnings.join(" ")} Approve the change and start implementing it?`,
        title: "Approve and implement?",
      });
      if (!ok) {
        return;
      }
    }
    approve.mutate(!change.validation.valid);
  };
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
      {code.length > 0 && (
        <Alert className="border-warn/40 text-warn">
          <TriangleAlertIcon />
          <AlertTitle>The agent changed code before approval</AlertTitle>
          <AlertDescription>
            <span className="font-mono text-xs break-all">
              {code.join(", ")}
            </span>
          </AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={blocker !== undefined || approve.isPending}
          onClick={() => void onApprove()}
        >
          {approve.isPending ? "Approving…" : "Approve and implement"}
        </Button>
        {blocker ? (
          <span className={muted}>{blocker}</span>
        ) : (
          !notice && (
            <span className={muted}>
              Nothing is implemented until you approve the spec.
            </span>
          )
        )}
        {approve.error && (
          <span className="text-destructive">{approve.error.message}</span>
        )}
        {notice && <span className="text-ok">{notice}</span>}
      </div>
    </div>
  );
};
