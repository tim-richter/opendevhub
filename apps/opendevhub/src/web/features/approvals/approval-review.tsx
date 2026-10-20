import { Badge } from "@opendevhub/ui/badge";
import { Button } from "@opendevhub/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opendevhub/ui/dialog";
import { ShieldAlertIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import type {
  ConfigApprovalChange,
  PendingConfigApproval,
  ProjectView,
} from "../../../shared/types";
import { approveConfig, refuseConfig } from "../../api";
import { muted } from "../../components/page";
import { useDash } from "../../dashboard-context";
import {
  approvalSummary,
  composeFileDiffs,
  formatValue,
  settingLabel,
  sourceLabels,
} from "./approvals";
import type { DiffLine } from "./approvals";

const KIND_STYLE: Record<ConfigApprovalChange["kind"], string> = {
  added: "border-attention/50 text-attention",
  changed: "border-warn/50 text-warn",
  removed: "text-muted-foreground",
  unchanged: "text-muted-foreground",
};

const LINE_MARK: Record<DiffLine["kind"], string> = {
  added: "+ ",
  removed: "- ",
  same: "  ",
};

const Value = ({ value, tone }: { value: unknown; tone?: string }) => (
  <pre
    className={cn(
      "bg-muted/50 max-h-48 overflow-auto rounded-md px-3 py-2 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap",
      tone
    )}
  >
    {formatValue(value)}
  </pre>
);

const ComposeDiff = ({ change }: { change: ConfigApprovalChange }) => (
  <div className="flex flex-col gap-2">
    {composeFileDiffs(change).map((file) => (
      <div key={file.path} className="flex flex-col gap-1">
        <p className="font-mono text-xs">{file.path}</p>
        <pre className="bg-muted/50 max-h-64 overflow-auto rounded-md py-2 font-mono text-xs leading-relaxed">
          {file.lines.map((line, i) => (
            <div
              // Lines repeat; their position is their identity.
              // oxlint-disable-next-line eslint-plugin-react/no-array-index-key
              key={i}
              className={cn(
                "px-3 break-all whitespace-pre-wrap",
                line.kind === "added" && "bg-ok/10 text-ok",
                line.kind === "removed" && "bg-destructive/10 text-destructive"
              )}
            >
              {LINE_MARK[line.kind]}
              {line.text}
            </div>
          ))}
        </pre>
      </div>
    ))}
  </div>
);

/** A changed setting's value: Compose files as a line diff, anything else before and after. */
const ChangeValue = ({ change }: { change: ConfigApprovalChange }) => {
  if (change.kind === "unchanged") {
    return null;
  }
  if (change.key === "dockerComposeFile") {
    return <ComposeDiff change={change} />;
  }
  return (
    <>
      {change.kind === "changed" && (
        <Value
          value={change.before}
          tone="text-muted-foreground line-through"
        />
      )}
      <Value value={change.kind === "removed" ? change.before : change.after} />
    </>
  );
};

const ChangeRow = ({ change }: { change: ConfigApprovalChange }) => (
  <li className="flex flex-col gap-1.5 border-t py-3 first:border-t-0">
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium">{settingLabel(change.key)}</span>
      <Badge variant="outline" className={KIND_STYLE[change.kind]}>
        {change.kind}
      </Badge>
    </div>
    <ChangeValue change={change} />
  </li>
);

/** The pending settings against the closest approved ones, with Approve and Keep stopped. */
export const ApprovalReview = (props: {
  view: ProjectView;
  approval: PendingConfigApproval;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { view, approval } = props;
  const { report } = useDash();
  const [busy, setBusy] = useState(false);
  const changed = approval.changes.filter((c) => c.kind !== "unchanged");
  const unchanged = approval.changes.filter((c) => c.kind === "unchanged");
  const answer = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      props.onOpenChange(false);
    } catch (error) {
      // A 409 means the config changed again: the banner already shows the new settings.
      report(error);
      props.onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlertIcon className="text-attention size-4" />
            Review container config
          </DialogTitle>
          <DialogDescription>
            {approval.first
              ? "This project's devcontainer config acts on this machine, outside its container. Nothing of it has been approved yet."
              : "This project's devcontainer config changed settings that act on this machine, outside its container, since you last approved it."}{" "}
            From {sourceLabels(approval).join(", ")}.
          </DialogDescription>
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6">
          {approval.mergedError && (
            <p className={cn(muted, "pb-2")}>
              Its features&apos; metadata couldn&apos;t be read (
              {approval.mergedError}), so the features themselves count.
            </p>
          )}
          <ul>
            {changed.map((c) => (
              <ChangeRow key={c.key} change={c} />
            ))}
          </ul>
          {unchanged.length > 0 && (
            <p className={cn(muted, "border-t py-3")}>
              Unchanged: {unchanged.map((c) => settingLabel(c.key)).join(", ")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void answer(() =>
                refuseConfig(view.project.id, approval.fingerprint)
              )
            }
          >
            Keep stopped
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void answer(() =>
                approveConfig(view.project.id, approval.fingerprint)
              )
            }
          >
            Approve and start
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/**
 * Shown on the project overview and on a worktree row while a container start waits for the user to approve its
 * config's host-affecting settings.
 */
export const ApprovalBanner = (props: {
  view: ProjectView;
  approval: PendingConfigApproval;
  /** On a worktree row or a variant card: tighter. */
  compact?: boolean;
}) => {
  const { view, approval, compact } = props;
  const { report } = useDash();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      role="alert"
      className={cn(
        "border-attention/50 bg-attention/5 relative flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border text-sm",
        compact ? "px-3 py-2" : "px-4 py-3"
      )}
    >
      <ShieldAlertIcon className="text-attention size-4 shrink-0" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">Container config needs approval</span>
        <span className="text-muted-foreground truncate text-xs">
          {approvalSummary(approval)}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Review
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void act(() => refuseConfig(view.project.id, approval.fingerprint))
          }
        >
          Keep stopped
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            void act(() => approveConfig(view.project.id, approval.fingerprint))
          }
        >
          Approve
        </Button>
      </div>
      <ApprovalReview
        key={approval.fingerprint}
        view={view}
        approval={approval}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
};

/** Every pending approval of the project, for its overview. */
export const ProjectApprovals = ({ view }: { view: ProjectView }) =>
  view.approvals && view.approvals.length > 0 ? (
    <div className="flex flex-col gap-2">
      {view.approvals.map((a) => (
        <ApprovalBanner key={a.fingerprint} view={view} approval={a} />
      ))}
    </div>
  ) : null;
