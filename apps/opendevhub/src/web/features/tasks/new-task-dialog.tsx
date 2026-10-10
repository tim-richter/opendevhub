import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, PlayIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";

import { jiraTaskPrompt } from "../../../shared/jira";
import { branchSlug, deriveTitle, taskBranches } from "../../../shared/tasks";
import type { Isolation, ModelsInfo, TaskWhere } from "../../../shared/types";
import { createTask, fetchModels } from "../../api";
import { Choice } from "../../components/choice";
import { useDash } from "../../dashboard-context";
import type { NewTaskDraft } from "../../dashboard-context";
import { useNavigate } from "../../routing";
import { nodeChoices } from "../nodes/nodes";
import { projectFlags } from "../projects/project-actions";
import { specUnavailable, taskPath } from "./tasks";
import { EMPTY_ROW, rowsToVariants, VariantRows } from "./variant-rows";
import type { VariantRow } from "./variant-rows";

const NO_MODELS: ModelsInfo = { agents: [], models: [] };

export const NewTaskDialog = () => {
  const { snapshot, newTaskFor, closeNewTask } = useDash();
  if (!snapshot || !newTaskFor) {
    return null;
  }
  // Mounted per opening, with integration context prefilled when provided.
  return (
    <TaskForm
      initialProject={newTaskFor.projectId}
      draft={newTaskFor}
      onClose={closeNewTask}
    />
  );
};

const TaskForm = ({
  initialProject,
  draft,
  onClose,
}: {
  initialProject?: string;
  draft?: NewTaskDraft;
  onClose: () => void;
}) => {
  const { snapshot, act } = useDash();
  const jira = draft?.jira;
  const navigate = useNavigate();
  const projects = useMemo(
    () =>
      [...(snapshot?.projects ?? [])].toSorted((a, b) =>
        a.project.name.localeCompare(b.project.name)
      ),
    [snapshot]
  );
  const [projectId, setProjectId] = useState(
    () =>
      initialProject ??
      projects.find((v) => v.runtime.containerState === "running")?.project
        .id ??
      projects[0]?.project.id ??
      ""
  );
  const [prompt, setPrompt] = useState(
    () => draft?.prompt ?? (jira ? jiraTaskPrompt(jira) : "")
  );
  const [title, setTitle] = useState(
    () =>
      draft?.title ?? (jira ? `${jira.key}: ${jira.title}`.slice(0, 200) : "")
  );
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState(draft?.base ?? "");
  const [where, setWhere] = useState<TaskWhere>("worktree");
  const [environment, setEnvironment] = useState<Isolation>();
  const [node, setNode] = useState("local");
  const [rows, setRows] = useState<VariantRow[]>([EMPTY_ROW]);
  const [specFirst, setSpecFirst] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const view = projects.find((v) => v.project.id === projectId);
  const nodes = snapshot?.nodes ?? [];
  const remote = node !== "local";
  const flags = view
    ? projectFlags(view, (snapshot?.preflight.errors.length ?? 0) > 0)
    : undefined;
  const canOpen = flags?.canOpen ?? false;
  const worktreesReady = view?.runtime.worktreeRoot?.mounted === true;
  let effectiveWhere: TaskWhere;
  if (remote) {
    effectiveWhere = "worktree";
  } else if (worktreesReady) {
    effectiveWhere = where;
  } else {
    effectiveWhere = "workspace";
  }
  const isolation = view?.isolation;
  let chosenEnv: Isolation;
  if (remote) {
    chosenEnv = "isolated";
  } else if (isolation?.unsupported) {
    chosenEnv = "shared";
  } else {
    chosenEnv = environment ?? isolation?.default ?? "shared";
  }
  const shownRows = effectiveWhere === "worktree" ? rows : rows.slice(0, 1);
  const isMac =
    typeof navigator !== "undefined" && /mac/iu.test(navigator.platform);

  // Cached per project, so the dialog opens with its lists ready; without them, it offers the defaults. Refreshed on
  // every opening, so a model, agent or OpenSpec setup added since shows up.
  const modelsQuery = useQuery({
    enabled: canOpen && !!projectId,
    queryFn: () => fetchModels(projectId ?? ""),
    queryKey: ["models", projectId],
    refetchOnMount: "always",
  });
  const models: ModelsInfo | undefined =
    modelsQuery.data ?? (modelsQuery.isError ? NO_MODELS : undefined);

  const variants = rowsToVariants(shownRows, models);
  const specBlocked = models?.spec ? specUnavailable(models.spec) : undefined;
  const spec = specFirst && !!models?.spec && !specBlocked;
  const shownTitle = title.trim() || deriveTitle(prompt);
  const preview =
    effectiveWhere === "worktree" && shownTitle
      ? taskBranches({
          branch: branch.trim() || undefined,
          title: shownTitle,
          variants,
        })
      : [];

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!view || !prompt.trim() || !canOpen || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const worktree = effectiveWhere === "worktree";
    createTask(view.project.id, {
      prompt,
      ...(jira ? { jira } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      where: effectiveWhere,
      ...(worktree ? { environment: chosenEnv } : {}),
      ...(remote ? { node } : {}),
      ...(worktree && branch.trim() ? { branch: branch.trim() } : {}),
      ...(worktree && base.trim() ? { base: base.trim() } : {}),
      ...(spec ? { spec: true as const } : {}),
      variants,
    })
      .then(
        (result) => {
          // The variants are set up in the background; the task's page shows how far each one got.
          onClose();
          void navigate(taskPath(view.project.id, result.task));
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
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          promptRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {jira ? `New task from ${jira.key}` : "New task"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Start an agent on a prompt in one of your projects.
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="task-project">Project</Label>
            <Choice
              id="task-project"
              size="default"
              className="w-full"
              value={projectId}
              options={projects.map((v) => ({
                label: v.project.name,
                value: v.project.id,
              }))}
              onChange={(id) => {
                setProjectId(id);
                setRows([EMPTY_ROW]);
                setEnvironment(undefined);
                setNode("local");
              }}
            />
          </div>

          {view && !canOpen && (
            <Alert className="border-warn/40 bg-warn/10 text-warn">
              <AlertDescription className="text-warn flex items-center justify-between gap-2">
                <span>
                  {notRunningMessage(flags?.transitioning, flags?.unhealthy)}
                </span>
                {!flags?.transitioning && !flags?.unhealthy && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={flags?.locked}
                    onClick={() => act(view.project.id, "start")}
                  >
                    <PlayIcon className="size-3" /> Start project
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}

          <div className="grid gap-2">
            <Label htmlFor="task-prompt">Prompt</Label>
            <Textarea
              id="task-prompt"
              ref={promptRef}
              rows={6}
              className="min-h-28"
              value={prompt}
              placeholder={
                spec
                  ? "What should the change propose?"
                  : "What should the agent do?"
              }
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>

          {models?.spec && (
            <div className="flex flex-col gap-1 text-sm">
              <Label className="font-normal">
                <Checkbox
                  checked={spec}
                  disabled={!!specBlocked}
                  onCheckedChange={(c) => setSpecFirst(c === true)}
                />{" "}
                Spec first
              </Label>
              <span className="text-muted-foreground">
                {specBlocked ??
                  "The agent proposes an OpenSpec change (proposal, specs, design, tasks) before writing any code."}
              </span>
            </div>
          )}

          {nodes.length > 1 && (
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <Label
                htmlFor="task-node"
                className="text-muted-foreground font-normal"
              >
                Node
              </Label>
              <Choice
                id="task-node"
                value={node}
                options={nodeChoices(nodes)}
                onChange={setNode}
              />
              {remote && (
                <span className="text-muted-foreground">
                  {isolation?.unsupported ??
                    "Runs in a new worktree with its own container, from the base pushed to that node."}
                </span>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-4 text-sm">
            <span className="text-muted-foreground">Where</span>
            <RadioGroup
              className="flex flex-wrap gap-4"
              value={effectiveWhere}
              onValueChange={(v) => setWhere(v as TaskWhere)}
              aria-label="Where"
            >
              <Label className="font-normal">
                <RadioGroupItem
                  value="worktree"
                  disabled={remote || !worktreesReady}
                />{" "}
                New worktree
              </Label>
              <Label className="font-normal">
                <RadioGroupItem value="workspace" disabled={remote} /> Main
                checkout
              </Label>
            </RadioGroup>
            {view && canOpen && !worktreesReady && (
              <span className="text-muted-foreground">
                Rebuild the container to enable worktrees.
              </span>
            )}
          </div>

          {effectiveWhere === "worktree" && (
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <span className="text-muted-foreground">Environment</span>
              <RadioGroup
                className="flex flex-wrap gap-4"
                value={chosenEnv}
                onValueChange={(v) => setEnvironment(v as Isolation)}
                aria-label="Environment"
              >
                <Label className="font-normal">
                  <RadioGroupItem value="shared" disabled={remote} /> Shared
                  container
                </Label>
                <Label className="font-normal" title={isolation?.unsupported}>
                  <RadioGroupItem
                    value="isolated"
                    disabled={remote || !!isolation?.unsupported}
                  />{" "}
                  Own container
                </Label>
              </RadioGroup>
              {isolation?.unsupported && (
                <span className="text-muted-foreground">
                  {isolation.unsupported}
                </span>
              )}
            </div>
          )}

          <VariantRows
            rows={shownRows}
            setRows={setRows}
            models={models}
            canAdd={effectiveWhere === "worktree"}
          />

          <Collapsible className="group/options flex flex-col gap-3">
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1 self-start text-sm">
              <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]/options:rotate-90" />{" "}
              Options
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-3">
              <div className="grid gap-2">
                <Label htmlFor="task-title">Title</Label>
                <Input
                  id="task-title"
                  value={title}
                  maxLength={200}
                  placeholder={
                    deriveTitle(prompt) || "First line of the prompt"
                  }
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              {effectiveWhere === "worktree" && (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="task-branch">Branch</Label>
                    <Input
                      id="task-branch"
                      value={branch}
                      placeholder={branchSlug(shownTitle)}
                      onChange={(e) => setBranch(e.target.value)}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="task-base">Base</Label>
                    <Input
                      id="task-base"
                      value={base}
                      placeholder="the main checkout's current branch"
                      onChange={(e) => setBase(e.target.value)}
                    />
                  </div>
                </>
              )}
            </CollapsibleContent>
          </Collapsible>

          {preview.length > 0 && (
            <p className="text-muted-foreground text-xs">
              {preview.length === 1 ? "Branch" : "Branches"}:{" "}
              <code className="font-mono">{preview.join(", ")}</code>
              {!branch.trim() || preview.length > 1
                ? " — a number is added when one is taken"
                : ""}
            </p>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="items-center">
            <span className="text-muted-foreground mr-auto text-xs">
              {isMac ? "⌘" : "Ctrl"}+Enter to start
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!view || !prompt.trim() || !canOpen || busy}
            >
              {startLabel(busy, variants.length)}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

const notRunningMessage = (
  transitioning: boolean | undefined,
  unhealthy: boolean | undefined
): string => {
  if (transitioning) {
    return "Starting the project…";
  }
  return unhealthy
    ? "opencode is not responding. Restart it from the project's menu."
    : "The project isn't running. Start it to run a task.";
};

const startLabel = (busy: boolean, variants: number): string => {
  if (busy) {
    return "Starting…";
  }
  return variants > 1 ? `Start ${variants} variants` : "Start task";
};
