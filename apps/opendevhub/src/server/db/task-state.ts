import type { StartStep, TaskState } from "../../shared/types";

/** Steps a variant passes through before its session is created. */
const SETUP_STEPS: ReadonlySet<StartStep> = new Set([
  "queued",
  "pushing",
  "worktree",
  "image",
  "container",
]);

/** The variant columns a task's state depends on. */
export interface VariantState {
  step: StartStep;
  session_id: string | null;
  session_removed_at: number | null;
  discarded_at: number | null;
}

/** Being set up: its job hasn't created its session yet. */
export const settingUp = (v: VariantState): boolean =>
  SETUP_STEPS.has(v.step) || (v.step === "session" && v.session_id === null);

const live = (v: VariantState): boolean =>
  v.session_id !== null &&
  v.session_removed_at === null &&
  v.discarded_at === null;

export const taskState = (variants: readonly VariantState[]): TaskState => {
  if (
    variants.some(
      (v) => settingUp(v) || (v.step === "failed" && v.discarded_at === null)
    )
  ) {
    return "starting";
  }
  return variants.some(live) ? "running" : "ended";
};
