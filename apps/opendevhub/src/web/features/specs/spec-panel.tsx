import { useQuery } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  LockIcon,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";
import type { ReactNode } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import type {
  RequirementChange,
  RequirementOperation,
  ReviewData,
  SessionSummary,
  SpecArtifact,
  SpecChange,
  SpecPhase,
  TaskView,
} from "../../../shared/types";
import { MarkdownBody } from "../../components/markdown-body";
import type { MarkdownBlock } from "../../components/markdown-body";
import { muted, Section, Segmented } from "../../components/page";
import { DiffLinesSkeleton } from "../../components/skeletons";
import { Link } from "../../routing";
import { taskPath, variantName } from "../tasks/tasks";
import { ApproveSpec, TaskProgress } from "./spec-approve";
import { ArchiveSpec } from "./spec-archive";
import {
  AnchorComments,
  CommentButton,
  SendComments,
  useSpecComments,
} from "./spec-comments";
import type { SpecComments } from "./spec-comments";
import { specQuery } from "./spec-queries";
import {
  artifactLabel,
  blockAnchor,
  byCapability,
  codeChanges,
  documentTabs,
  PHASE_LABEL,
  requirementAnchor,
  requirementBody,
  taskProgress,
  tasksDone,
} from "./specs";
import type { SpecAnchor } from "./specs";

const PROGRESS_POLL_MS = 15_000;

// The diff highlighter is large; load it with the first modified requirement on screen.
const RequirementDiff = lazy(() => import("./requirement-diff"));

const OPERATION_TONE: Record<RequirementOperation, string> = {
  ADDED: "border-ok/40 text-ok",
  MODIFIED: "border-warn/40 text-warn",
  REMOVED: "border-destructive/40 text-destructive",
  RENAMED: "border-border text-muted-foreground",
};

const ArtifactStep = ({ artifact }: { artifact: SpecArtifact }) => {
  const done = artifact.status === "done";
  const blocked = artifact.status === "blocked";
  let Icon = CircleDashedIcon;
  if (done) {
    Icon = CheckIcon;
  } else if (blocked) {
    Icon = LockIcon;
  }
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1",
        done ? "text-ok" : "text-muted-foreground"
      )}
      title={
        artifact.missingDeps
          ? `Waits for ${artifact.missingDeps.join(", ")}`
          : artifact.status
      }
    >
      <Icon className="size-3.5" />
      {artifactLabel(artifact)}
    </span>
  );
};

const Requirement = ({
  requirement: r,
  anchor,
  comments,
}: {
  requirement: RequirementChange;
  anchor: SpecAnchor;
  comments?: SpecComments;
}) => (
  <li className="flex flex-col gap-2 border-t px-4 py-3 first:border-t-0">
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline" className={OPERATION_TONE[r.operation]}>
        {r.operation}
      </Badge>
      <span className="font-medium">
        {r.from ? (
          <>
            <span className="text-muted-foreground line-through">{r.from}</span>{" "}
            → {r.name}
          </>
        ) : (
          r.name
        )}
      </span>
      {comments && (
        <CommentButton
          label={`Comment on ${r.name}`}
          className="ml-auto"
          onClick={() => comments.edit(anchor)}
        />
      )}
    </div>
    {r.operation === "MODIFIED" && r.before !== undefined && (
      <div className="overflow-hidden rounded-md border">
        <Suspense fallback={<DiffLinesSkeleton />}>
          <RequirementDiff
            name={`${r.capability}.md`}
            before={requirementBody(r.before)}
            after={requirementBody(r.delta)}
          />
        </Suspense>
      </div>
    )}
    {r.operation === "REMOVED" && r.before !== undefined && (
      <MarkdownBody className="text-muted-foreground line-through">
        {requirementBody(r.before)}
      </MarkdownBody>
    )}
    {(r.operation === "ADDED" ||
      r.operation === "REMOVED" ||
      (r.operation === "MODIFIED" && r.before === undefined)) &&
      requirementBody(r.delta) && (
        <MarkdownBody>{requirementBody(r.delta)}</MarkdownBody>
      )}
    {comments && <AnchorComments anchor={anchor} comments={comments} />}
  </li>
);

const ChangeBody = ({
  change,
  projectId,
  directory,
  review,
  archive,
}: {
  change: SpecChange;
  projectId: string;
  directory: string;
  /**
   * Present while the spec is proposed: whether the agent is working, code it changed outside `openspec/`, and
   * whether the checkout is a worktree of its own.
   */
  review?: { busy: boolean; code?: string[]; worktree: boolean };
  /** Present once every task of the implemented change is done: whether the agent is working. */
  archive?: { busy: boolean };
}) => {
  const tabs = documentTabs(change);
  const [tab, setTab] = useState<string>();
  const shown = tabs.find((t) => t.id === tab) ?? tabs[0];
  const groups = byCapability(change.requirements);
  const drafts = useSpecComments(projectId, directory, change.name);
  const comments = review ? drafts : undefined;
  const shownFile = shown?.id;
  const blockAside = (block: MarkdownBlock) => {
    if (!comments || !shownFile) {
      return null;
    }
    const anchor = blockAnchor(shownFile, block);
    return (
      <>
        <CommentButton
          label="Comment on this"
          className="absolute top-0 right-0 opacity-0 group-hover/block:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={() => comments.edit(anchor)}
        />
        <AnchorComments anchor={anchor} comments={comments} />
      </>
    );
  };
  return (
    <div className="flex flex-col gap-4 px-4 py-3">
      {!change.validation.valid && (
        <Alert variant="destructive">
          <AlertTitle>openspec validate finds problems</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {change.validation.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {shown ? (
        <div className="flex flex-col gap-3">
          {tabs.length > 1 && (
            <Segmented
              label="Document"
              value={shown.id}
              options={tabs.map((t) => ({ id: t.id, label: t.label }))}
              onChange={setTab}
            />
          )}
          <MarkdownBody blockAside={comments ? blockAside : undefined}>
            {shown.content}
          </MarkdownBody>
        </div>
      ) : (
        <p className={muted}>The change has no documents yet.</p>
      )}
      {groups.length > 0 && (
        <div className="flex flex-col gap-3">
          <h3 className="font-semibold">Requirements</h3>
          {groups.map(([capability, requirements]) => (
            <div key={capability} className="rounded-md border">
              <div className="bg-muted/40 border-b px-4 py-2 font-mono text-xs">
                {capability}
              </div>
              <ul>
                {requirements.map((r) => (
                  <Requirement
                    key={`${r.operation}:${r.from ?? ""}:${r.name}`}
                    requirement={r}
                    anchor={requirementAnchor(change, r)}
                    comments={comments}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {review && (
        <SendComments
          projectId={projectId}
          directory={directory}
          change={change.name}
          comments={drafts}
          blocked={
            review.busy
              ? "The agent is working; send when its turn ends."
              : undefined
          }
        />
      )}
      {review && (
        <ApproveSpec
          projectId={projectId}
          directory={directory}
          change={change}
          busy={review.busy}
          code={review.code}
          worktree={review.worktree}
        />
      )}
      {archive && (
        <ArchiveSpec
          projectId={projectId}
          directory={directory}
          change={change.name}
          busy={archive.busy}
        />
      )}
    </div>
  );
};

/** One checkout's change: its name (or a choice of the new ones), phase, artifact chain and contents. */
export const SpecPanel = (props: {
  projectId: string;
  directory: string;
  phase: SpecPhase;
  /** The task's agent is working, so comments and approval wait for its turn to end. */
  busy?: boolean;
  /** The checkout's changes, for code written before approval; undefined while loading, null if unreadable. */
  checkout?: ReviewData | null;
  /** The checkout is a worktree of its own, so the change can be implemented in new ones to compare models. */
  worktree?: boolean;
  /** The task that implements this checkout's change in new worktrees, or that proposed the change this one implements. */
  links?: { implementedIn?: string; proposedIn?: string };
}) => {
  const { implementedIn, proposedIn } = props.links ?? {};
  const [picked, setPicked] = useState<string>();
  const implementing = props.phase === "implement" && props.busy === true;
  const query = useQuery({
    ...specQuery(props.projectId, props.directory, picked),
    // Tasks get ticked off during the agent's turn; follow them while it implements.
    refetchInterval: implementing ? PROGRESS_POLL_MS : false,
  });
  if (query.isError) {
    return (
      <p className="text-destructive px-4 py-3 text-sm">
        {query.error.message}
      </p>
    );
  }
  const view = query.data;
  if (!view) {
    return (
      <div className="flex flex-col gap-2 px-4 py-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (view.unavailable) {
    return <p className={cn(muted, "px-4 py-3")}>{view.unavailable}</p>;
  }
  const { change } = view;
  // The change can be archived before the task's phase catches up.
  const phase = change?.archived ? "archived" : props.phase;
  // Implemented in another task's worktrees, this checkout's tasks stay unticked.
  const progress =
    phase === "implement" && !implementedIn ? taskProgress(view) : undefined;
  const fresh = view.changes.filter((c) => c.isNew);
  const choices = fresh.length > 1 ? fresh : [];
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3 text-sm">
        {choices.length > 0 && change ? (
          <Segmented
            label="Change"
            value={change.name}
            options={choices.map((c) => ({ id: c.name, label: c.name }))}
            onChange={setPicked}
          />
        ) : (
          <strong className="font-mono">
            {change?.name ?? "No change yet"}
          </strong>
        )}
        <Badge variant="secondary">{PHASE_LABEL[phase]}</Badge>
        {progress && <TaskProgress {...progress} />}
        {implementedIn && phase === "implement" && (
          <TaskLink projectId={props.projectId} task={implementedIn}>
            Implemented in a task per model
          </TaskLink>
        )}
        {proposedIn && (
          <TaskLink projectId={props.projectId} task={proposedIn}>
            Proposed in its own task
          </TaskLink>
        )}
        {change?.archived && (
          <span className="text-muted-foreground font-mono text-xs">
            openspec/changes/archive/{change.archived}
          </span>
        )}
        {change && change.artifacts.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            {change.artifacts.map((a, i) => (
              <span key={a.id} className="inline-flex items-center gap-1.5">
                {i > 0 && (
                  <ChevronRightIcon className="text-muted-foreground size-3.5" />
                )}
                <ArtifactStep artifact={a} />
              </span>
            ))}
          </span>
        )}
      </div>
      {change ? (
        <ChangeBody
          key={change.name}
          change={change}
          projectId={props.projectId}
          directory={props.directory}
          review={
            phase === "propose"
              ? {
                  busy: props.busy ?? false,
                  worktree: props.worktree ?? false,
                  code:
                    props.checkout === undefined
                      ? undefined
                      : codeChanges(props.checkout),
                }
              : undefined
          }
          archive={
            progress && tasksDone(progress)
              ? { busy: props.busy ?? false }
              : undefined
          }
        />
      ) : (
        <p className={cn(muted, "px-4 py-3")}>
          The agent hasn&apos;t proposed a change in this checkout yet.
        </p>
      )}
    </div>
  );
};

const TaskLink = (props: {
  projectId: string;
  task: string;
  children: ReactNode;
}) => (
  <Link
    to={taskPath(props.projectId, props.task)}
    className="text-primary inline-flex items-center gap-1 text-xs hover:underline"
  >
    {props.children}
    <ArrowRightIcon className="size-3" />
  </Link>
);

/** A spec-first task's Spec section: one tab per variant's checkout. */
export const SpecSection = (props: {
  projectId: string;
  /** The task the sessions are variants of: their phases and its links. */
  task: TaskView;
  sessions: SessionSummary[];
  /** Each checkout's changes, by directory. */
  reviews?: Record<string, ReviewData | null>;
}) => {
  const { sessions } = props;
  const [directory, setDirectory] = useState<string>();
  const shown = sessions.find((s) => s.directory === directory) ?? sessions[0];
  const variant = props.task.variants.find((v) => v.sessionId === shown?.id);
  const phase = variant?.spec?.phase;
  if (!shown || !phase) {
    return null;
  }
  return (
    <Section
      title="Spec"
      hint={sessions.length > 1 ? undefined : "OpenSpec change"}
      action={
        sessions.length > 1 && (
          <Segmented
            label="Variant"
            value={shown.directory}
            options={sessions.map((s) => ({
              id: s.directory,
              label: variantName(s),
            }))}
            onChange={setDirectory}
          />
        )
      }
    >
      <SpecPanel
        key={shown.directory}
        projectId={props.projectId}
        directory={shown.directory}
        phase={phase}
        busy={shown.status !== "idle"}
        checkout={props.reviews?.[shown.directory]}
        worktree={variant?.branch !== undefined}
        links={props.task.spec}
      />
    </Section>
  );
};
