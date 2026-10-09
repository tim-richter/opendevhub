import { useQuery } from "@tanstack/react-query";
import { CheckIcon, CircleDashedIcon, LockIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import type {
  RequirementChange,
  RequirementOperation,
  SessionSummary,
  SpecArtifact,
  SpecChange,
  SpecPhase,
} from "../../../shared/types";
import { MarkdownBody } from "../../components/markdown-body";
import { muted, Section, Segmented } from "../../components/page";
import { DiffLinesSkeleton } from "../../components/skeletons";
import { variantName } from "../tasks/tasks";
import { specQuery } from "./spec-queries";
import {
  artifactLabel,
  byCapability,
  documentTabs,
  PHASE_LABEL,
  requirementBody,
} from "./specs";

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
}: {
  requirement: RequirementChange;
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
  </li>
);

const ChangeBody = ({ change }: { change: SpecChange }) => {
  const tabs = documentTabs(change);
  const [tab, setTab] = useState<string>();
  const shown = tabs.find((t) => t.id === tab) ?? tabs[0];
  const groups = byCapability(change.requirements);
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
          <MarkdownBody>{shown.content}</MarkdownBody>
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
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/** One checkout's change: its name (or a choice of the new ones), phase, artifact chain and contents. */
export const SpecPanel = (props: {
  projectId: string;
  directory: string;
  phase: SpecPhase;
}) => {
  const [picked, setPicked] = useState<string>();
  const query = useQuery(specQuery(props.projectId, props.directory, picked));
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
        <Badge variant="secondary">{PHASE_LABEL[props.phase]}</Badge>
        {change && change.artifacts.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            {change.artifacts.map((a, i) => (
              <span key={a.id} className="inline-flex items-center gap-1.5">
                {i > 0 && <span className="text-muted-foreground">→</span>}
                <ArtifactStep artifact={a} />
              </span>
            ))}
          </span>
        )}
      </div>
      {change ? (
        <ChangeBody key={change.name} change={change} />
      ) : (
        <p className={cn(muted, "px-4 py-3")}>
          The agent hasn&apos;t proposed a change in this checkout yet.
        </p>
      )}
    </div>
  );
};

/** A spec-first task's Spec section: one tab per variant's checkout. */
export const SpecSection = (props: {
  projectId: string;
  sessions: SessionSummary[];
}) => {
  const { sessions } = props;
  const [directory, setDirectory] = useState<string>();
  const shown = sessions.find((s) => s.directory === directory) ?? sessions[0];
  const phase = shown?.task?.spec?.phase;
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
      />
    </Section>
  );
};
