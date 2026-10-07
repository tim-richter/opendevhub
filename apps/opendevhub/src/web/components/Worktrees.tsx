import { type FormEvent, useCallback, useState } from "react";
import { useNavigate } from "react-router";
import type { EnvironmentView, ProjectView } from "../../shared/types";
import { createEnv, createWorktree, envAction, removeEnv, removeWorktree, startSession } from "../api";
import { BoxIcon, PlusIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type Checkout, checkoutPath } from "../checkouts";
import { useDash } from "../DashboardContext";
import { envOfDirectory } from "../derive";
import { openSessionTab, projectFlags } from "./ProjectActions";
import { Tip } from "./Tip";

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
  const containerAction = (env: EnvironmentView, action: "start" | "stop" | "rebuild" | "restart-opencode") =>
    busy(`env:${env.id}`, () => envAction(view.project.id, env.id, action));
  const removeContainer = (env: EnvironmentView, label: string) => {
    const text = env.node
      ? `Remove ${label} from ${env.node}? Its container, worktree and branch there are deleted; bring the branch home first to keep its commits.`
      : `Remove the container of ${label}? Its sessions are deleted; the worktree and its files stay.`;
    if (!confirm(text)) return;
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
            <DropdownMenuItem
              disabled={settling}
              onSelect={() => {
                if (confirm(`Rebuild the container of ${c.label}? Running sessions will be interrupted.`)) containerAction(env, "rebuild");
              }}
            >
              Rebuild container
            </DropdownMenuItem>
            <DropdownMenuItem disabled={settling || state !== "running"} onSelect={() => containerAction(env, "restart-opencode")}>
              Restart opencode
            </DropdownMenuItem>
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

/** "New worktree": a dialog that creates one (optionally with a session in it), then goes to it. */
export function NewWorktreeButton({ view }: { view: ProjectView }) {
  const navigate = useNavigate();
  const { running, canOpen } = projectFlags(view, false);
  const { pending, busy } = useCheckoutActions(view);
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [withSession, setWithSession] = useState(true);
  const blocker = !running
    ? "Start the project to create worktrees"
    : !view.runtime.worktreeRoot?.mounted
      ? "Rebuild the container to create worktrees"
      : undefined;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const req = { branch, base: base || undefined, startSession: withSession && canOpen };
    const create = async () => {
      const res = await createWorktree(view.project.id, req);
      setBranch("");
      setBase("");
      setOpen(false);
      const folder = res.worktree?.path.split("/").filter(Boolean).at(-1);
      if (folder) void navigate(checkoutPath(view.project.id, folder));
      return res.sessionId;
    };
    busy("create", () => (req.startSession ? openSessionTab(view, create) : create()));
  };
  const creating = pending === "create";

  return (
    <>
      <Tip label={blocker ?? "Create a worktree on a new branch"}>
        {/* A disabled button gets no hover, so the wrapper carries the tooltip. */}
        <span>
          <Button variant="outline" size="sm" disabled={!!blocker} onClick={() => setOpen(true)}>
            <PlusIcon /> New worktree
          </Button>
        </span>
      </Tip>
      <Dialog open={open} onOpenChange={(o) => !creating && setOpen(o)}>
        <DialogContent showCloseButton={!creating}>
          <DialogHeader>
            <DialogTitle>New worktree</DialogTitle>
            <DialogDescription>A new branch in its own folder, next to {view.project.name}.</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <div className="flex flex-col gap-2">
              <Label htmlFor="worktree-branch">Branch</Label>
              <Input id="worktree-branch" placeholder="feature/login" value={branch} onChange={(e) => setBranch(e.target.value)} required autoFocus />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="worktree-base">From</Label>
              <Input id="worktree-base" placeholder="current HEAD" value={base} onChange={(e) => setBase(e.target.value)} />
            </div>
            <Label className="font-normal text-muted-foreground" title={canOpen ? undefined : "opencode is not running"}>
              <Checkbox checked={withSession && canOpen} disabled={!canOpen} onCheckedChange={(c) => setWithSession(c === true)} />
              Start a session
            </Label>
            <DialogFooter>
              <Button type="button" variant="ghost" disabled={creating} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!branch.trim() || creating}>
                <PlusIcon /> {creating ? "Creating…" : "Create worktree"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
