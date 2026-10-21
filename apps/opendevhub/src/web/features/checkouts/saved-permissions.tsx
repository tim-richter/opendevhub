import { Button } from "@opendevhub/ui/button";
import { Card } from "@opendevhub/ui/card";
import { Input } from "@opendevhub/ui/input";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { confirm } from "@/components/confirm-dialog";

import type { SavedPermission } from "../../../shared/types";
import {
  fetchSavedPermissions,
  removeSavedPermission,
  updateSavedPermission,
} from "../../api";
import { Note } from "../../components/page";
import { relativeTime } from "../../derive";
import { SAVED_PERMISSIONS_ID } from "./checkouts";
import { useEnvironment } from "./runtime-controls";

/** Patterns that allow an action on everything. */
const BROAD = new Set(["*", "**"]);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The rules opencode saved when someone answered a permission prompt with "always", read from the environment's
 * opencode each time the section shows. Each can be removed, and on opencode 2.1+ edited in place.
 */
export const SavedPermissions = () => {
  const { view, envId, runtime } = useEnvironment();
  const projectId = view.project.id;
  const running = runtime.containerState === "running";
  const queryKey = ["saved-permissions", projectId, envId];
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery({
    enabled: running,
    queryFn: ({ signal }) => fetchSavedPermissions(projectId, envId, signal),
    queryKey,
    staleTime: 0,
  });
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.location.hash === `#${SAVED_PERMISSIONS_ID}`) {
      section.current?.scrollIntoView({ block: "start" });
    }
  }, []);
  const refresh = () => queryClient.invalidateQueries({ queryKey });

  const unavailable = running
    ? data?.unavailable
    : "Start the container to see its saved permissions.";
  return (
    <section
      ref={section}
      id={SAVED_PERMISSIONS_ID}
      aria-labelledby={`${SAVED_PERMISSIONS_ID}-title`}
      className="flex scroll-mt-4 flex-col gap-3"
    >
      <header>
        <h2
          id={`${SAVED_PERMISSIONS_ID}-title`}
          className="text-base font-semibold"
        >
          Saved permissions
        </h2>
        <p className="text-muted-foreground text-sm">
          What the agent may do without asking, saved when someone answered a
          permission prompt with &ldquo;Always allow&rdquo;. Remove a rule to be
          asked again.
        </p>
      </header>
      {unavailable && <Note>{unavailable}</Note>}
      {!unavailable && error && <Note error>{messageOf(error)}</Note>}
      {!unavailable && !error && isPending && (
        <p className="text-muted-foreground text-sm">Loading…</p>
      )}
      {!unavailable && data && data.rules.length === 0 && (
        <p className="text-muted-foreground text-sm">No saved permissions.</p>
      )}
      {!unavailable && data && data.rules.length > 0 && (
        <Card className="overflow-hidden py-0">
          <ul className="divide-y">
            {data.rules.map((rule) => (
              <RuleRow
                key={rule.id}
                rule={rule}
                canEdit={data.canEdit}
                onRemove={async () => {
                  await removeSavedPermission(projectId, envId, rule.id);
                  await refresh();
                }}
                onSave={async (changes) => {
                  await updateSavedPermission(
                    projectId,
                    envId,
                    rule.id,
                    changes
                  );
                  await refresh();
                }}
              />
            ))}
          </ul>
        </Card>
      )}
      {!unavailable && data && !data.canEdit && data.rules.length > 0 && (
        <p className="text-muted-foreground text-xs">
          Editing rules needs opencode 2.1 or later; they can still be removed.
        </p>
      )}
    </section>
  );
};

const RuleRow = (props: {
  rule: SavedPermission;
  canEdit: boolean;
  onRemove: () => Promise<void>;
  onSave: (changes: { action?: string; resource?: string }) => Promise<void>;
}) => {
  const { rule } = props;
  const [editing, setEditing] = useState(false);
  const [action, setAction] = useState(rule.action);
  const [resource, setResource] = useState(rule.resource);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const attempt = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await run();
      return true;
    } catch (error_) {
      setError(messageOf(error_));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const yes = await confirm({
      confirmLabel: "Remove",
      description: `The agent will ask again before ${rule.action} on ${rule.resource}.`,
      destructive: true,
      title: "Remove this saved permission?",
    });
    if (yes) {
      await attempt(props.onRemove);
    }
  };

  const save = async () => {
    const next = { action: action.trim(), resource: resource.trim() };
    if (!next.action || !next.resource) {
      setError("Give an action and a pattern.");
      return;
    }
    const changes = {
      ...(next.action === rule.action ? {} : { action: next.action }),
      ...(next.resource === rule.resource ? {} : { resource: next.resource }),
    };
    if (Object.keys(changes).length === 0) {
      setEditing(false);
      return;
    }
    if (
      changes.resource !== undefined &&
      BROAD.has(changes.resource) &&
      !(await confirm({
        confirmLabel: "Allow everything",
        description: `The agent will run ${next.action} on anything without asking.`,
        destructive: true,
        title: `Allow ${next.action} on every resource?`,
      }))
    ) {
      return;
    }
    if (await attempt(() => props.onSave(changes))) {
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <li className="px-4 py-3">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label
            htmlFor={`${rule.id}-action`}
            className="flex flex-[0_1_10rem] flex-col gap-1 text-xs"
          >
            Action
            <Input
              id={`${rule.id}-action`}
              autoFocus
              className="h-8 font-mono"
              value={action}
              onChange={(e) => setAction(e.target.value)}
            />
          </label>
          <label
            htmlFor={`${rule.id}-resource`}
            className="flex flex-[1_1_16rem] flex-col gap-1 text-xs"
          >
            Pattern
            <Input
              id={`${rule.id}-resource`}
              className="h-8 font-mono"
              value={resource}
              onChange={(e) => setResource(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
            />
          </label>
          <Button type="submit" size="sm" disabled={busy}>
            Save
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setAction(rule.action);
              setResource(rule.resource);
              setError(undefined);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
        </form>
        {error && (
          <p className="text-destructive mt-2 text-xs" role="alert">
            {error}
          </p>
        )}
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
      <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
        {rule.action}
      </code>
      <code className="min-w-0 flex-1 font-mono text-xs wrap-anywhere">
        {rule.resource}
      </code>
      <span
        className="text-muted-foreground text-xs"
        title={new Date(rule.updatedAt).toLocaleString()}
      >
        {rule.updatedAt > rule.createdAt ? "changed " : "saved "}
        {relativeTime(rule.updatedAt)}
      </span>
      <div className="flex gap-1">
        {props.canEdit && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setEditing(true)}
          >
            Edit
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          disabled={busy}
          onClick={() => void remove()}
        >
          Remove
        </Button>
      </div>
      {error && (
        <p className="text-destructive w-full text-xs" role="alert">
          {error}
        </p>
      )}
    </li>
  );
};
