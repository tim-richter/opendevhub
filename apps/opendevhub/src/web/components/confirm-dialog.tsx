import { useSyncExternalStore } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ConfirmOptions {
  title: string;
  description?: string;
  /** The confirm button's label; "Continue" when unset. */
  confirmLabel?: string;
  /** Styles the confirm button as destructive, for deletions and other losses. */
  destructive?: boolean;
}

interface ConfirmState {
  request?: ConfirmOptions & { resolve: (ok: boolean) => void };
  // Kept apart from `request` so the dialog keeps its text while it animates closed.
  open: boolean;
}

let state: ConfirmState = { open: false };
const listeners = new Set<() => void>();

const setState = (next: ConfirmState) => {
  state = next;
  for (const listener of listeners) {
    listener();
  }
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const answer = (ok: boolean) => {
  if (!state.open) {
    return;
  }
  state.request?.resolve(ok);
  setState({ ...state, open: false });
};

/**
 * Asks the user to confirm in a modal, like `window.confirm`, resolving to their answer.
 * Needs a mounted `<ConfirmDialogHost />`; a newer request cancels a pending one.
 */
export const confirm = (options: ConfirmOptions): Promise<boolean> =>
  new Promise((resolve) => {
    answer(false);
    setState({ open: true, request: { ...options, resolve } });
  });

/** Renders the dialog `confirm` opens; mount it once near the root. */
export const ConfirmDialogHost = () => {
  const { open, request } = useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  );
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          answer(false);
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{request?.title}</AlertDialogTitle>
          {request?.description && (
            <AlertDialogDescription className="whitespace-pre-line">
              {request.description}
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={request?.destructive ? "destructive" : "default"}
            onClick={() => answer(true)}
          >
            {request?.confirmLabel ?? "Continue"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
