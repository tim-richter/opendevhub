import type { ProjectView, VariantView } from "../../../shared/types";
import { Empty, muted } from "../../components/page";
import { ApprovalBanner } from "../approvals/approval-review";
import { worktreeApproval } from "../approvals/approvals";
import { checkoutOf } from "../checkouts/checkouts";
import type { Checkout } from "../checkouts/checkouts";
import { startStepLabel } from "./tasks";

const folderName = (path: string) => path.split("/").findLast(Boolean) ?? path;

/** The checkout a conversation runs in; a removed worktree still has turns worth reading, its changes just won't load. */
export const conversationCheckout = (
  view: ProjectView,
  directory: string
): Checkout =>
  checkoutOf(view, directory) ?? {
    directory,
    label: folderName(directory),
    target: folderName(directory),
  };

/**
 * A variant without a conversation to show: how far its setup got, that it failed, or that its conversation is gone.
 * With `details`, also its error and the last lines its setup wrote, for a page without the task's starting cards.
 */
export const VariantWaiting = ({
  view,
  variant,
  details = false,
}: {
  view: ProjectView;
  variant: VariantView;
  details?: boolean;
}) => {
  if (variant.sessionRemoved) {
    return (
      <Empty title="Conversation removed">
        <p className={muted}>
          This variant&apos;s conversation is gone from opencode.
          {variant.directory &&
            checkoutOf(view, variant.directory) &&
            " Its changes, terminal and runtime are still here."}
        </p>
      </Empty>
    );
  }
  let progress = `${startStepLabel(variant.step)}…`;
  if (variant.step === "failed") {
    progress = "This variant failed to start.";
  } else if (variant.sessionId) {
    // Created, but not yet in the snapshot.
    progress = "Opening the conversation…";
  }
  const approval =
    variant.step === "approval"
      ? worktreeApproval(view, variant.branch, variant.node)
      : undefined;
  return (
    <Empty title="No conversation yet">
      <p className={muted}>{progress}</p>
      {approval && (
        <div className="w-full max-w-xl text-left">
          <ApprovalBanner view={view} approval={approval} compact />
        </div>
      )}
      {details && variant.error && (
        <p className="text-destructive max-w-prose text-sm break-words">
          {variant.error}
        </p>
      )}
      {details && variant.log && variant.log.length > 0 && (
        <pre className="bg-muted/50 text-muted-foreground max-h-48 w-full overflow-auto rounded-md px-3 py-2 text-left font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {variant.log.join("\n")}
        </pre>
      )}
    </Empty>
  );
};
