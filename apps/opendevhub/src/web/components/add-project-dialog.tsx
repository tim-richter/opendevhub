import { PlayIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";

import { renderDevcontainer, STACK_IDS, STACKS } from "../../shared/stacks";
import type { StackId } from "../../shared/stacks";
import type { Candidate, CandidateList } from "../../shared/types";
import { addProject, fetchCandidates } from "../api";
import { useDash } from "../dashboard-context";
import { addedDestination, candidateLabel } from "../onboarding";
import { useNavigate } from "../routing";
import { Choice } from "./choice";

export const AddProjectDialog = () => {
  const { addProjectOpen, closeAddProject } = useDash();
  // Mounted per opening, so it always lists fresh candidates.
  return addProjectOpen ? <AddProjectForm onClose={closeAddProject} /> : null;
};

const AddProjectForm = ({ onClose }: { onClose: () => void }) => {
  const { report } = useDash();
  const navigate = useNavigate();
  const [list, setList] = useState<CandidateList>();
  const [picked, setPicked] = useState<Candidate>();
  const [stack, setStack] = useState<StackId>("generic");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    fetchCandidates().then(
      (l) => live && setList(l),
      (err) =>
        live && setError(err instanceof Error ? err.message : String(err))
    );
    return () => {
      live = false;
    };
  }, []);

  const pick = (c: Candidate) => {
    setPicked(c);
    setStack(c.stack);
    setError(undefined);
  };

  const submit = () => {
    if (!picked || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    addProject(picked.path, stack)
      .then(
        (result) => {
          onClose();
          void navigate(addedDestination(result));
          if (!result.started) {
            report(
              new Error(
                `Added ${picked.name}, but it wasn't started: ${result.error ?? "unknown reason"}`
              )
            );
          }
        },
        (err) => setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Pick a git repo under your roots that has no devcontainer.
            opendevhub writes one that installs opencode.
          </DialogDescription>
        </DialogHeader>

        {picked ? (
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{picked.name}</div>
                <div className="text-muted-foreground truncate">
                  {picked.path}
                </div>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setPicked(undefined)}
              >
                Change
              </Button>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="add-project-stack">Base image</Label>
              <Choice
                id="add-project-stack"
                size="default"
                className="w-full"
                value={stack}
                options={STACK_IDS.map((id) => ({
                  label: STACKS[id].label,
                  title: STACKS[id].image,
                  value: id,
                }))}
                onChange={(v) => setStack(v as StackId)}
              />
              <p className="text-muted-foreground text-xs">
                Detected: {STACKS[picked.stack].label}
              </p>
            </div>
            <div className="grid gap-2">
              <Label>.devcontainer/devcontainer.json</Label>
              <pre className="bg-muted/40 overflow-x-auto rounded-md border p-3 font-mono text-xs">
                {renderDevcontainer(picked.name, stack)}
              </pre>
              <p className="text-muted-foreground text-xs">
                The file is left uncommitted.
              </p>
            </div>
          </div>
        ) : (
          <Command className="rounded-md border">
            <CommandInput placeholder="Filter repos" />
            <CommandList className="max-h-72">
              {!list && !error && (
                <div className="grid gap-2 p-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-8" />
                  ))}
                </div>
              )}
              {list && list.candidates.length === 0 && (
                <div className="text-muted-foreground p-3 text-sm">
                  {list.roots.length > 0
                    ? `No git repos without a devcontainer under ${list.roots.join(", ")}`
                    : "No folders to look in yet. Add them under Settings → Projects."}
                </div>
              )}
              {list && list.candidates.length > 0 && (
                <CommandEmpty>No match</CommandEmpty>
              )}
              {list?.candidates.map((c) => (
                <CommandItem
                  key={c.path}
                  value={`${c.name} ${c.path}`}
                  onSelect={() => pick(c)}
                >
                  <span className="font-medium">{c.name}</span>
                  <span className="text-muted-foreground truncate">
                    {candidateLabel(c)}
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!picked || busy} onClick={submit}>
            <PlayIcon className="size-3" /> {busy ? "Adding…" : "Add and start"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
