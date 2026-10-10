import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import type { SpecChange } from "../../../shared/types";
import { fetchModels, implementSpec } from "../../api";
import { useNavigate } from "../../routing";
import { taskPath } from "../tasks/tasks";
import { EMPTY_ROW, rowsToVariants, VariantRows } from "../tasks/variant-rows";
import type { VariantRow } from "../tasks/variant-rows";
import { specKey } from "./spec-queries";
import { approveWarnings } from "./specs";

/**
 * Approves the proposed change and implements it in a new task, one worktree per chosen model, to compare them.
 * The spec is committed on its branch first, so every worktree starts from it.
 */
export const ImplementWithModels = (props: {
  projectId: string;
  directory: string;
  change: SpecChange;
  /** Files changed outside `openspec/`, which stay uncommitted in the spec's checkout. */
  code: string[];
  onClose: () => void;
}) => {
  const { change, projectId } = props;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [rows, setRows] = useState<VariantRow[]>([EMPTY_ROW, EMPTY_ROW]);
  const modelsQuery = useQuery({
    queryFn: () => fetchModels(projectId),
    queryKey: ["models", projectId],
  });
  const models = modelsQuery.data;
  const variants = rowsToVariants(rows, models);
  const warnings = approveWarnings(change, props.code);
  const implement = useMutation({
    mutationFn: () =>
      implementSpec(projectId, {
        change: change.name,
        directory: props.directory,
        force: !change.validation.valid,
        variants,
      }),
    onSuccess: async ({ task }) => {
      props.onClose();
      await queryClient.invalidateQueries({
        queryKey: specKey(projectId, props.directory),
      });
      void navigate(taskPath(projectId, task));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!implement.isPending) {
      implement.mutate();
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !implement.isPending && props.onClose()}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Implement with several models</DialogTitle>
          <DialogDescription>
            Commits <code className="font-mono">openspec/</code> on this
            task&apos;s branch, then starts a task with a worktree from it per
            model, each running /opsx-apply {change.name}.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <VariantRows rows={rows} setRows={setRows} models={models} canAdd />
          {warnings.length > 0 && (
            <Alert className="border-warn/40 text-warn">
              <TriangleAlertIcon />
              <AlertDescription className="text-warn">
                {warnings.join(" ")}
                {props.code.length > 0 &&
                  " Only openspec/ is committed; the code stays in this checkout."}
              </AlertDescription>
            </Alert>
          )}
          {implement.error && (
            <Alert variant="destructive">
              <AlertDescription>{implement.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={implement.isPending}
              onClick={props.onClose}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={implement.isPending}>
              {implementLabel(implement.isPending, variants.length)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const implementLabel = (pending: boolean, variants: number): string => {
  if (pending) {
    return "Starting…";
  }
  return variants === 1
    ? "Approve and implement in a new worktree"
    : `Approve and implement with ${variants} models`;
};
