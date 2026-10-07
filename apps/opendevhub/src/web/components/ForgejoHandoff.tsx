import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import type { ForgejoPullDetails } from "../../shared/forgejo";
import { fetchPublishInfo, sendPrompt, startSession } from "../api";
import {
  checkouts,
  checkoutPath,
  checkoutRuntime,
  sessionPath,
} from "../checkouts";
import { useDash } from "../DashboardContext";
import {
  forgejoAgentPrompt,
  matchesForgejoCheckout,
  matchesForgejoPull,
} from "../forgejo";
import { useForgejoQuery } from "../hooks/useForgejo";
import { Choice } from "./Choice";
import { RequestState } from "./ForgejoContext";
import type { ForgejoFeedback } from "./ForgejoContext";
import { Note } from "./Page";

export const ForgejoHandoff = ({
  details,
  feedback,
  onClose,
}: {
  details: ForgejoPullDetails;
  feedback: ForgejoFeedback;
  onClose: () => void;
}) => {
  const { snapshot, newTask } = useDash();
  const navigate = useNavigate();
  const projects = snapshot?.projects ?? [];
  const [projectId, setProjectId] = useState("");
  const [directory, setDirectory] = useState("");
  const [session, setSession] = useState("");
  const [prompt, setPrompt] = useState(() =>
    forgejoAgentPrompt(details, feedback)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fingerprint = projects.map((p) => [
    p.project.id,
    p.runtime.containerState,
    p.runtime.worktrees?.map((w) => [w.path, w.head, w.branch]),
  ]);
  const links = useForgejoQuery(
    ["local-links", details.pull.url, details.headSha, fingerprint],
    async (signal) => {
      const candidates = projects
        .filter((p) => p.runtime.containerState === "running")
        .flatMap((view) =>
          checkouts(view).map((checkout) => ({ checkout, view }))
        );
      const matches: {
        projectId: string;
        directory: string;
        exact: boolean;
      }[] = [];
      let skipped = 0;
      const queue = [...candidates];
      // Bound git work to four checkouts at once; inspect all remotes so forks work too.
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          while (queue.length && !signal.aborted) {
            const item = queue.shift();
            if (!item) {
              break;
            }
            try {
              let info = await fetchPublishInfo(
                item.view.project.id,
                item.checkout.directory,
                undefined,
                signal
              );
              if (!matchesForgejoPull(details, info)) {
                for (const remote of info.remotes.filter(
                  (r) => r !== info.remote
                )) {
                  info = await fetchPublishInfo(
                    item.view.project.id,
                    item.checkout.directory,
                    remote,
                    signal
                  );
                  if (matchesForgejoPull(details, info)) {
                    break;
                  }
                }
              }
              if (matchesForgejoPull(details, info)) {
                matches.push({
                  directory: item.checkout.directory,
                  exact: matchesForgejoCheckout(
                    details,
                    info,
                    item.checkout.worktree?.head
                  ),
                  projectId: item.view.project.id,
                });
              }
            } catch {
              if (!signal.aborted) {
                skipped += 1;
              }
            }
          }
        })
      );
      return {
        matches: matches.toSorted(
          (a, b) =>
            Number(b.exact) - Number(a.exact) ||
            a.projectId.localeCompare(b.projectId)
        ),
        skipped,
      };
    }
  );
  useEffect(() => {
    if (projectId) {
      return;
    }
    const first = links.data?.matches[0];
    if (first) {
      setProjectId(first.projectId);
      setDirectory(first.directory);
    }
  }, [links.data, projectId]);
  const project = projects.find((v) => v.project.id === projectId);
  const locations = project ? checkouts(project) : [];
  const checkout = locations.find((c) => c.directory === directory);
  const runtime =
    project && checkout ? checkoutRuntime(project, directory) : undefined;
  const ready =
    runtime?.containerState === "running" && runtime.opencode === "healthy";
  const sessions =
    project?.sessions.filter((s) => s.directory === directory) ?? [];
  const send = async () => {
    if (!project || !checkout || !prompt.trim() || !ready) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      let id = session;
      if (id) {
        await sendPrompt(projectId, id, prompt);
      } else {
        id = await startSession(
          projectId,
          directory,
          `PR #${details.pull.number}: ${details.pull.title}`.slice(0, 200),
          prompt
        );
      }
      const target = project.sessions.find((s) => s.id === id);
      onClose();
      void navigate(
        target
          ? sessionPath(project, target)
          : `${checkoutPath(projectId, checkout.target)}?session=${encodeURIComponent(id)}`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Continue with agent</DialogTitle>
          <DialogDescription>
            Review the PR context and selected feedback, then choose where to
            continue.
          </DialogDescription>
        </DialogHeader>
        <RequestState query={links} />
        {!!links.data?.skipped && (
          <Note warn>
            Some local checkouts could not be inspected. You can choose a
            project manually.
          </Note>
        )}
        {links.data && !links.data.matches.length && (
          <Note>
            No matching running project was found. Choose a local project or add
            this repository to the dashboard first.
          </Note>
        )}
        {!!links.data?.matches.length && (
          <div className="flex flex-wrap gap-2">
            {links.data.matches.map((m) => {
              const view = projects.find((p) => p.project.id === m.projectId);
              const c =
                view &&
                checkouts(view).find((k) => k.directory === m.directory);
              return (
                c && (
                  <Button
                    key={`${m.projectId}:${m.directory}`}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setProjectId(m.projectId);
                      setDirectory(m.directory);
                      setSession("");
                    }}
                  >
                    {view?.project.name} · {c.label}
                    {m.exact ? " · PR checkout" : " · Repository"}
                  </Button>
                )
              );
            })}
          </div>
        )}
        <fieldset disabled={busy} className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label htmlFor="forgejo-project">Project</Label>
            <Choice
              id="forgejo-project"
              value={projectId}
              options={[
                { label: "Choose a project", value: "" },
                ...projects.map((p) => ({
                  label: p.project.name,
                  value: p.project.id,
                })),
              ]}
              onChange={(id) => {
                setProjectId(id);
                setDirectory("");
                setSession("");
              }}
            />
          </div>
          {project && (
            <div className="grid gap-2">
              <Label htmlFor="forgejo-checkout">Checkout</Label>
              <Choice
                id="forgejo-checkout"
                value={directory}
                options={[
                  { label: "Choose a checkout", value: "" },
                  ...locations.map((c) => ({
                    label: c.label,
                    value: c.directory,
                  })),
                ]}
                onChange={(value) => {
                  setDirectory(value);
                  setSession("");
                }}
              />
              {checkout && (
                <Link
                  className="text-xs underline"
                  to={checkoutPath(projectId, checkout.target)}
                >
                  Open checkout
                </Link>
              )}
            </div>
          )}
          {checkout && (
            <div className="grid gap-2">
              <Label htmlFor="forgejo-session">Session</Label>
              <Choice
                id="forgejo-session"
                value={session}
                options={[
                  { label: "New session in this checkout", value: "" },
                  ...sessions.map((s) => ({
                    label: `${s.title} · ${s.status}`,
                    value: s.id,
                  })),
                ]}
                onChange={setSession}
              />
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="forgejo-prompt">Prompt</Label>
            <Textarea
              id="forgejo-prompt"
              rows={12}
              value={prompt}
              maxLength={100_000}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
        </fieldset>
        {checkout && !ready && (
          <Note warn>
            Start this checkout&apos;s container and opencode to send feedback
            here, or create a new task below.
          </Note>
        )}
        <Note>
          The agent will verify the PR commit before editing. Creating a new
          task opens the task form so you can choose its branch and environment.
        </Note>
        {error && (
          <div role="alert">
            <Note warn>{error}</Note>
          </div>
        )}
        <DialogFooter className="flex-wrap">
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={busy || !project || !prompt.trim()}
            onClick={() => {
              onClose();
              newTask(projectId, {
                prompt,
                title:
                  `PR #${details.pull.number}: ${details.pull.title}`.slice(
                    0,
                    200
                  ),
              });
            }}
          >
            Create new task…
          </Button>
          <Button
            disabled={busy || !ready || !checkout || !prompt.trim()}
            onClick={() => void send()}
          >
            {sendLabel(busy, !!session)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const sendLabel = (busy: boolean, hasSession: boolean): string => {
  if (busy) {
    return "Sending…";
  }
  return hasSession ? "Send to session" : "Start session";
};
