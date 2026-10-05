import { type FormEvent, useCallback, useState } from "react";
import { useNavigate } from "react-router";
import type { EnvironmentView, ProjectView } from "../../shared/types";
import { createEnv, createWorktree, envAction, removeEnv, removeWorktree, startSession } from "../api";
import { BoxIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type Checkout, checkoutPath } from "../checkouts";
import { useDash } from "../DashboardContext";
import { envOfDirectory } from "../derive";
import { openSessionTab, projectFlags } from "./ProjectActions";

/** Runs one checkout action at a time, reporting failures to the error banner. */
export function useCheckoutActions(view: ProjectView) {
  const { report } = useDash();
  const [pending, setPending] = useState<string>();
  const busy = useCallback(
    (key: string, fn: () => Promise<unknown>) => {
      setPending(key);
      void fn()
        .catch(report)
        .finally(() => setPending(undefined));
    },
    [report],
  );

  const newSession = (c: Checkout) =>
    busy(`session:${c.directory}`, () => openSessionTab(view, () => startSession(view.project.id, c.directory, c.worktree?.branch), c.directory));

  /** Removes a worktree after confirming, asking again before discarding uncommitted changes. */
  const remove = (c: Checkout, after?: () => void) => {
    const what = envOfDirectory(view, c.directory)
      ? "Its folder, its container and the container's sessions are deleted"
      : "Its folder is deleted";
    if (!confirm(`Remove the worktree ${c.label}? ${what}; the branch is kept.`)) return;
    busy(c.directory, async () => {
      try {
        await removeWorktree(view.project.id, c.directory, false);
      } catch (err) {
        if (!(err instanceof Error) || !/--force/.test(err.message)) throw err;
        if (!confirm(`${c.label} has uncommitted or untracked changes. Remove it anyway and discard them?`)) return;
        await removeWorktree(view.project.id, c.directory, true);
      }
      after?.();
    });
  };

  const ownContainer = (c: Checkout) => busy(`env:${c.directory}`, () => createEnv(view.project.id, c.directory));
  const containerAction = (env: EnvironmentView, action: "start" | "stop") =>
    busy(`env:${env.id}`, () => envAction(view.project.id, env.id, action));
  const removeContainer = (env: EnvironmentView, label: string) => {
    if (!confirm(`Remove the container of ${label}? Its sessions are deleted; the worktree and its files stay.`)) return;
    busy(`env:${env.id}`, () => removeEnv(view.project.id, env.id));
  };

  return { pending, busy, newSession, remove, ownContainer, containerAction, removeContainer };
}

/** Whether new sessions can start in a checkout: its own container's opencode, or the project's. */
export function checkoutReady(view: ProjectView, c: Checkout): boolean {
  const env = envOfDirectory(view, c.directory);
  return env ? env.runtime.opencode === "healthy" : projectFlags(view, false).canOpen;
}

/** A worktree's container: run it in its own, or start, stop and remove the one it has. */
export function ContainerMenu({ view, checkout: c, compact }: { view: ProjectView; checkout: Checkout; compact?: boolean }) {
  const { running } = projectFlags(view, false);
  const { pending, ownContainer, containerAction, removeContainer } = useCheckoutActions(view);
  if (!c.worktree) return null;
  const env = envOfDirectory(view, c.directory);
  const unsupported = view.isolation?.unsupported;
  const state = env?.runtime.containerState;
  const settling = state === "starting" || state === "stopping";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={compact ? "icon-sm" : "icon"}
          className="text-muted-foreground"
          aria-label={`Container of ${c.label}`}
          title="Container"
          disabled={!!pending}
        >
          <BoxIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {env ? (
          <>
            {state === "running" ? (
              <DropdownMenuItem onSelect={() => containerAction(env, "stop")}>Stop container</DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled={!running || settling} onSelect={() => containerAction(env, "start")}>
                Start container
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled={settling} onSelect={() => removeContainer(env, c.label)}>
              Remove container
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem
            disabled={!running || !!unsupported || !c.hostPath}
            title={unsupported ?? (c.hostPath ? "Run this worktree in its own devcontainer" : "Only worktrees in the mounted folder can")}
            onSelect={() => ownContainer(c)}
          >
            <span className="flex flex-col">
              Run in its own container
              {unsupported && <span className="max-w-64 text-xs text-muted-foreground">{unsupported}</span>}
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Shown when the container predates the worktree mount, so worktrees can't be opened on this machine. */
export function UnmountedNotice({ view }: { view: ProjectView }) {
  const { act, snapshot } = useDash();
  const { running, locked } = projectFlags(view, (snapshot?.preflight.errors.length ?? 0) > 0);
  const root = view.runtime.worktreeRoot;
  if (!running || !root || root.mounted) return null;
  return (
    <div className="flex items-center gap-3 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
      <span className="flex-1">
        This container was created before opendevhub mounted <code className="font-mono">{root.host}</code>. Rebuild it to create
        worktrees you can open on this machine.
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={locked}
        onClick={() => {
          if (confirm(`Rebuild the devcontainer for ${view.project.name}? Running sessions will be interrupted.`)) act(view.project.id, "rebuild");
        }}
      >
        Rebuild container
      </Button>
    </div>
  );
}

/** Creates a worktree (optionally with a session in it), then goes to it. */
export function NewWorktreeForm({ view }: { view: ProjectView }) {
  const navigate = useNavigate();
  const { canOpen } = projectFlags(view, false);
  const { pending, busy } = useCheckoutActions(view);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [withSession, setWithSession] = useState(true);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const req = { branch, base: base || undefined, startSession: withSession && canOpen };
    const create = async () => {
      const res = await createWorktree(view.project.id, req);
      setBranch("");
      setBase("");
      const folder = res.worktree?.path.split("/").filter(Boolean).at(-1);
      if (folder) void navigate(checkoutPath(view.project.id, folder));
      return res.sessionId;
    };
    busy("create", () => (req.startSession ? openSessionTab(view, create) : create()));
  };

  return (
    <Card className="py-0">
      <form className="flex flex-wrap items-center gap-2 px-4 py-3" onSubmit={submit}>
        <Input
          className="w-56 max-md:w-full"
          placeholder="Branch, e.g. feature/login"
          aria-label="Branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          required
        />
        <Input
          className="w-56 max-md:w-full"
          placeholder="From (default: current HEAD)"
          aria-label="Base"
          value={base}
          onChange={(e) => setBase(e.target.value)}
        />
        <Label className="font-normal text-muted-foreground" title={canOpen ? undefined : "opencode is not running"}>
          <Checkbox checked={withSession && canOpen} disabled={!canOpen} onCheckedChange={(c) => setWithSession(c === true)} />
          Start a session
        </Label>
        <Button type="submit" className="md:ml-auto" disabled={!branch.trim() || pending === "create"}>
          <PlusIcon /> {pending === "create" ? "Creating…" : "New worktree"}
        </Button>
      </form>
    </Card>
  );
}
