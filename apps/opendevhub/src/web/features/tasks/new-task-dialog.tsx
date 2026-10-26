import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Button } from "@opendevhub/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@opendevhub/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@opendevhub/ui/dialog";
import { Input } from "@opendevhub/ui/input";
import { Label } from "@opendevhub/ui/label";
import { RadioGroup, RadioGroupItem } from "@opendevhub/ui/radio-group";
import { Textarea } from "@opendevhub/ui/textarea";
import { useQuery } from "@tanstack/react-query";
import {
  BoxesIcon,
  ChevronRightIcon,
  CodeIcon,
  CompassIcon,
  FileTextIcon,
  GitBranchIcon,
  PlayIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import type { FormEvent } from "react";

import { jiraTaskPrompt } from "../../../shared/jira";
import { branchSlug, deriveTitle, taskBranches } from "../../../shared/tasks";
import type {
  Isolation,
  ModelsInfo,
  NewTaskBody,
  SpecStart,
  SpecWorkflow,
  TaskPlan,
  TaskVariantSpec,
  TaskWhere,
} from "../../../shared/types";
import {
  createDraft,
  createTask,
  editDraft,
  fetchModels,
  startDraft,
} from "../../api";
import { Choice } from "../../components/choice";
import { useDash } from "../../dashboard-context";
import type { NewTaskDraft } from "../../dashboard-context";
import { useNavigate } from "../../routing";
import { useShortcut, useShortcutLabel } from "../../shell/use-shortcut";
import { nodeChoices } from "../nodes/nodes";
import { projectFlags } from "../projects/project-actions";
import { basePositionQuery } from "./base-queries";
import { BaseStatusLine } from "./base-status-line";
import { modelKey, specUnavailable, taskPath } from "./tasks";
import { EMPTY_ROW, rowsToVariants, VariantRows } from "./variant-rows";
import type { VariantRow } from "./variant-rows";

const NO_MODELS: ModelsInfo = { agents: [], models: [] };

/** How a task starts: on the prompt, or spec-first by exploring or proposing. */
type TaskStart = "code" | SpecStart;

const CHOICE_CARD =
  "border-border has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-background flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm shadow-xs has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-50";

export const NewTaskDialog = () => {
  const { snapshot, newTaskFor, closeNewTask } = useDash();
  if (!snapshot || !newTaskFor) {
    return null;
  }
  // Mounted per opening, with integration context prefilled when provided.
  return (
    <TaskForm
      projectId={newTaskFor.projectId}
      draft={newTaskFor}
      onClose={closeNewTask}
    />
  );
};

const TaskForm = ({
  projectId,
  draft,
  onClose,
}: {
  projectId: string;
  draft?: NewTaskDraft;
  onClose: () => void;
}) => {
  const { snapshot, act } = useDash();
  const jira = draft?.jira;
  const plan = draft?.plan;
  const saved = draft?.draft;
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState(
    () => draft?.prompt ?? (jira ? jiraTaskPrompt(jira) : "")
  );
  const [title, setTitle] = useState(
    () =>
      draft?.title ?? (jira ? `${jira.key}: ${jira.title}`.slice(0, 200) : "")
  );
  const [branch, setBranch] = useState(plan?.branch ?? "");
  const [base, setBase] = useState(draft?.base ?? plan?.base ?? "");
  const [where, setWhere] = useState<TaskWhere>(plan?.where ?? "worktree");
  const [directory, setDirectory] = useState(plan?.directory ?? "");
  const [environment, setEnvironment] = useState<Isolation | undefined>(
    plan?.environment
  );
  const [node, setNode] = useState(plan?.node ?? "local");
  const [rows, setRows] = useState<VariantRow[]>(() =>
    plan && plan.variants.length > 0
      ? plan.variants.map(variantToRow)
      : [EMPTY_ROW]
  );
  const [start, setStart] = useState<TaskStart>(() => startOf(plan?.spec));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const view = snapshot?.projects.find((v) => v.project.id === projectId);
  const nodes = snapshot?.nodes ?? [];
  const remote = node !== "local";
  const flags = view
    ? projectFlags(view, (snapshot?.preflight.errors.length ?? 0) > 0)
    : undefined;
  const canOpen = flags?.canOpen ?? false;
  const worktreesReady = view?.runtime.worktreeRoot?.mounted === true;
  const localWorktrees = (view?.runtime.worktrees ?? []).filter(
    (worktree) => !worktree.node
  );
  let effectiveWhere: TaskWhere;
  if (remote) {
    effectiveWhere = "worktree";
  } else if (where === "existing") {
    effectiveWhere = "existing";
  } else if (worktreesReady) {
    effectiveWhere = where;
  } else {
    effectiveWhere = "workspace";
  }
  const isolation = view?.isolation;
  const selectedWorktree = localWorktrees.find(
    (worktree) => worktree.path === directory
  );
  const existingEnvironment = view?.environments.some(
    (candidate) => candidate.worktree.path === selectedWorktree?.path
  );
  const canIsolate =
    !isolation?.unsupported &&
    (effectiveWhere !== "existing" ||
      !!(selectedWorktree?.hostPath && selectedWorktree.branch));
  let chosenEnv: Isolation;
  if (remote) {
    chosenEnv = "isolated";
  } else if (canIsolate) {
    chosenEnv =
      environment ??
      (effectiveWhere === "existing" && existingEnvironment
        ? "isolated"
        : (isolation?.default ?? "shared"));
  } else {
    chosenEnv = "shared";
  }
  const shownRows = effectiveWhere === "worktree" ? rows : rows.slice(0, 1);
  const locationReady =
    effectiveWhere !== "existing" || selectedWorktree !== undefined;
  const startKeys = useShortcutLabel("newTaskStart");
  // A node's task branches from the base as it is, so only local worktree tasks get the line.
  const showBaseStatus = effectiveWhere === "worktree" && !remote && canOpen;
  // Read (and so fetched) on opening, while Options is still closed: the line is ready, and starting finds the fetch fresh.
  const [openedBase] = useState(base.trim());
  useQuery({
    ...basePositionQuery(projectId, openedBase),
    enabled: showBaseStatus,
  });

  // Cached per project, so the dialog opens with its lists ready; without them, it offers the defaults. Refreshed on
  // every opening, so a model, agent or OpenSpec setup added since shows up.
  const modelsQuery = useQuery({
    enabled: canOpen,
    queryFn: () => fetchModels(projectId),
    queryKey: ["models", projectId],
    refetchOnMount: "always",
  });
  const models: ModelsInfo | undefined =
    modelsQuery.data ?? (modelsQuery.isError ? NO_MODELS : undefined);

  const variants = rowsToVariants(shownRows, models);
  const specBlocked = models?.spec ? specUnavailable(models.spec) : undefined;
  const exploreBlocked =
    models?.spec && !models.spec.explore
      ? "opencode lacks opsx-explore; run `openspec update` in the repository."
      : undefined;
  const spec = specStartFor(start, models?.spec, specBlocked);
  const shownTitle = title.trim() || deriveTitle(prompt);
  const preview =
    effectiveWhere === "worktree" && shownTitle
      ? taskBranches({
          branch: branch.trim() || undefined,
          title: shownTitle,
          variants,
        })
      : [];

  /** What the form asks for, as a task request. */
  const request = (): NewTaskBody => {
    const worktree = effectiveWhere === "worktree";
    return {
      prompt,
      ...(jira ? { jira } : {}),
      ...(title.trim() ? { title: title.trim() } : {}),
      where: effectiveWhere,
      ...(effectiveWhere === "workspace" ? {} : { environment: chosenEnv }),
      ...(effectiveWhere === "existing" && selectedWorktree
        ? { directory: selectedWorktree.path }
        : {}),
      ...(remote ? { node } : {}),
      ...(worktree && branch.trim() ? { branch: branch.trim() } : {}),
      ...(worktree && base.trim() ? { base: base.trim() } : {}),
      ...(spec ? { spec } : {}),
      variants,
    };
  };

  const run = (job: () => Promise<string | undefined>) => {
    setBusy(true);
    setError(undefined);
    job()
      .then(
        (task) => {
          // The variants are set up in the background; the task's page shows how far each one got.
          onClose();
          if (task && view) {
            void navigate(taskPath(view.project.id, task));
          }
        },
        (err) => setError(err instanceof Error ? err.message : String(err))
      )
      .finally(() => setBusy(false));
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!view || !prompt.trim() || !canOpen || !locationReady || busy) {
      return;
    }
    if (saved?.mode === "edit") {
      saveDraft();
      return;
    }
    const { id } = view.project;
    run(async () => {
      const started = saved
        ? await startDraft(id, saved.task, request())
        : await createTask(id, request());
      return started.task;
    });
  };

  /** Saves the form as a draft, or saves the draft being edited; nothing starts. */
  const saveDraft = () => {
    if (!view || (!prompt.trim() && !title.trim()) || !locationReady || busy) {
      return;
    }
    const { id } = view.project;
    run(async () => {
      if (saved) {
        await editDraft(id, saved.task, request());
        return saved.task;
      }
      const drafted = await createDraft(id, request());
      return drafted.task;
    });
  };
  useShortcut("newTaskStart", () => submit(), {
    ignoreInputs: false,
    target: promptRef,
  });

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
            {dialogTitle(saved?.mode, jira?.key)}
            {view && (
              <span className="text-muted-foreground font-normal">
                {" "}
                in {view.project.name}
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Start an agent on a prompt in {view?.project.name ?? "this project"}
            .
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit}>
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
              placeholder={promptPlaceholder(spec)}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>

          {models?.spec && (
            <div className="grid gap-2">
              <span className="text-sm font-medium" id="task-start-label">
                Start with
              </span>
              <RadioGroup
                className="grid gap-2 sm:grid-cols-3"
                value={spec ?? "code"}
                onValueChange={(value) => setStart(value as TaskStart)}
                aria-labelledby="task-start-label"
              >
                <Label className={`${CHOICE_CARD} sm:row-start-2`}>
                  <RadioGroupItem value="code" />
                  <span className="grid gap-1">
                    <span className="flex items-center gap-1.5 font-medium">
                      <CodeIcon className="size-4" /> Code
                    </span>
                    <span className="text-muted-foreground text-xs font-normal">
                      The agent works on the prompt right away
                    </span>
                  </span>
                </Label>
                <span className="text-muted-foreground -mb-1 flex flex-col gap-1 pt-1 text-xs sm:col-span-2 sm:col-start-2 sm:row-start-1 sm:pt-0">
                  <span id="task-spec-label">
                    Spec first <span className="opacity-70">· OpenSpec</span>
                  </span>
                  <span className="border-border h-1.5 rounded-t-sm border-x border-t" />
                </span>
                <Label
                  className={`${CHOICE_CARD} sm:row-start-2`}
                  title={specBlocked ?? exploreBlocked}
                >
                  <RadioGroupItem
                    value="explore"
                    aria-describedby="task-spec-label"
                    disabled={!!specBlocked || !!exploreBlocked}
                  />
                  <span className="grid gap-1">
                    <span className="flex items-center gap-1.5 font-medium">
                      <CompassIcon className="size-4" /> Explore
                    </span>
                    <span className="text-muted-foreground text-xs font-normal">
                      Think it through together, then propose
                    </span>
                  </span>
                </Label>
                <Label
                  className={`${CHOICE_CARD} sm:row-start-2`}
                  title={specBlocked}
                >
                  <RadioGroupItem
                    value="propose"
                    aria-describedby="task-spec-label"
                    disabled={!!specBlocked}
                  />
                  <span className="grid gap-1">
                    <span className="flex items-center gap-1.5 font-medium">
                      <FileTextIcon className="size-4" /> Propose
                    </span>
                    <span className="text-muted-foreground text-xs font-normal">
                      Proposal, specs, design and tasks before any code
                    </span>
                  </span>
                </Label>
              </RadioGroup>
              {(specBlocked ?? (start === "explore" && exploreBlocked)) && (
                <p className="text-muted-foreground text-xs">
                  {specBlocked ?? exploreBlocked}
                </p>
              )}
            </div>
          )}

          <fieldset className="border-border bg-muted/20 grid gap-4 rounded-xl border p-4">
            <legend className="px-1 text-sm font-semibold">
              Where and environment
            </legend>
            {nodes.length > 1 && (
              <div className="grid gap-2">
                <Label htmlFor="task-node">Run on</Label>
                <Choice
                  id="task-node"
                  value={node}
                  options={nodeChoices(nodes)}
                  onChange={setNode}
                  className="w-full sm:w-64"
                />
                {remote && (
                  <p className="text-muted-foreground text-xs">
                    A new worktree and its own container will be created on this
                    node.
                  </p>
                )}
              </div>
            )}
            <div className="grid gap-2">
              <span className="text-sm font-medium" id="task-location-label">
                Checkout
              </span>
              <RadioGroup
                className="grid gap-2 sm:grid-cols-3"
                value={effectiveWhere}
                onValueChange={(value) => setWhere(value as TaskWhere)}
                aria-labelledby="task-location-label"
              >
                <Label className="border-border has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-background flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm shadow-xs has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-50">
                  <RadioGroupItem
                    value="worktree"
                    disabled={!worktreesReady && !remote}
                  />
                  <span className="grid gap-1">
                    <span className="flex items-center gap-1.5 font-medium">
                      <GitBranchIcon className="size-4" /> New worktree
                    </span>
                    <span className="text-muted-foreground text-xs font-normal">
                      A fresh branch for this task
                    </span>
                  </span>
                </Label>
                <Label className="border-border has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-background flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm shadow-xs has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-50">
                  <RadioGroupItem
                    value="existing"
                    disabled={remote || localWorktrees.length === 0}
                  />
                  <span className="grid gap-1">
                    <span className="flex items-center gap-1.5 font-medium">
                      <GitBranchIcon className="size-4" /> Existing worktree
                    </span>
                    <span className="text-muted-foreground text-xs font-normal">
                      Continue in a checkout
                    </span>
                  </span>
                </Label>
                <Label className="border-border has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-background flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm shadow-xs has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-50">
                  <RadioGroupItem value="workspace" disabled={remote} />
                  <span className="grid gap-1">
                    <span className="font-medium">Main checkout</span>
                    <span className="text-muted-foreground text-xs font-normal">
                      Use the project’s current files
                    </span>
                  </span>
                </Label>
              </RadioGroup>
              {view && canOpen && !worktreesReady && !remote && (
                <p className="text-muted-foreground text-xs">
                  Rebuild the container to create new worktrees.
                </p>
              )}
            </div>
            {effectiveWhere === "existing" && (
              <div className="grid gap-2">
                <Label htmlFor="task-directory">Worktree</Label>
                <Choice
                  id="task-directory"
                  value={selectedWorktree?.path ?? ""}
                  options={[
                    { value: "", label: "Choose a worktree" },
                    ...localWorktrees.map((worktree) => ({
                      value: worktree.path,
                      label: worktree.branch ?? worktree.path,
                      title: worktree.path,
                    })),
                  ]}
                  onChange={setDirectory}
                  className="w-full"
                />
                {directory && !selectedWorktree && (
                  <p className="text-destructive text-xs">
                    This worktree is no longer available. Choose another.
                  </p>
                )}
              </div>
            )}
            {effectiveWhere === "workspace" && (
              <p className="text-muted-foreground text-xs">
                The main checkout uses the project’s running container.
              </p>
            )}
            {effectiveWhere !== "workspace" && (
              <div className="grid gap-2">
                <span
                  className="text-sm font-medium"
                  id="task-environment-label"
                >
                  Environment
                </span>
                <RadioGroup
                  className="grid gap-2 sm:grid-cols-2"
                  value={chosenEnv}
                  onValueChange={(value) => setEnvironment(value as Isolation)}
                  aria-labelledby="task-environment-label"
                >
                  <Label className="border-border has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-background flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm shadow-xs has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-50">
                    <RadioGroupItem value="shared" disabled={remote} />
                    <span className="grid gap-1">
                      <span className="font-medium">Shared container</span>
                      <span className="text-muted-foreground text-xs font-normal">
                        Use the project’s running environment
                      </span>
                    </span>
                  </Label>
                  <Label
                    className="border-border has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-background flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-sm shadow-xs has-[[data-disabled]]:cursor-not-allowed has-[[data-disabled]]:opacity-50"
                    title={isolation?.unsupported}
                  >
                    <RadioGroupItem
                      value="isolated"
                      disabled={!remote && !canIsolate}
                    />
                    <span className="grid gap-1">
                      <span className="flex items-center gap-1.5 font-medium">
                        <BoxesIcon className="size-4" /> Own container
                      </span>
                      <span className="text-muted-foreground text-xs font-normal">
                        Keep processes and ports separate
                      </span>
                    </span>
                  </Label>
                </RadioGroup>
                {isolation?.unsupported && (
                  <p className="text-muted-foreground text-xs">
                    {isolation.unsupported}
                  </p>
                )}
                {effectiveWhere === "existing" &&
                  selectedWorktree &&
                  !selectedWorktree.hostPath && (
                    <p className="text-muted-foreground text-xs">
                      This worktree has no local folder for an own container.
                    </p>
                  )}
              </div>
            )}
          </fieldset>

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
                      aria-describedby={
                        showBaseStatus ? "task-base-status" : undefined
                      }
                      onChange={(e) => setBase(e.target.value)}
                    />
                    {showBaseStatus && (
                      <BaseStatusLine
                        id="task-base-status"
                        projectId={projectId}
                        base={base}
                      />
                    )}
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
              {startKeys && `${startKeys} to start`}
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            {saved?.mode !== "start" && (
              <Button
                type="button"
                variant={saved?.mode === "edit" ? "default" : "outline"}
                disabled={
                  !view ||
                  (!prompt.trim() && !title.trim()) ||
                  !locationReady ||
                  busy
                }
                title="Keep this task for later; nothing runs until you start it"
                onClick={saveDraft}
              >
                {saved?.mode === "edit" ? "Save draft" : "Save as draft"}
              </Button>
            )}
            {saved?.mode !== "edit" && (
              <Button
                type="submit"
                disabled={
                  !view || !prompt.trim() || !canOpen || !locationReady || busy
                }
              >
                {startLabel(busy, variants.length)}
              </Button>
            )}
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

const dialogTitle = (
  mode: "start" | "edit" | undefined,
  key: string | undefined
): string => {
  if (mode === "edit") {
    return "Edit draft";
  }
  if (mode === "start") {
    return "Start draft";
  }
  return key ? `New task from ${key}` : "New task";
};

/** How a draft starts; drafts saved before exploring could be chosen say `true` for proposing. */
const startOf = (spec: TaskPlan["spec"]): TaskStart => {
  if (spec === "explore") {
    return "explore";
  }
  return spec === true || spec === "propose" ? "propose" : "code";
};

/** The spec-first start the task gets, when the environment can run it. */
const specStartFor = (
  start: TaskStart,
  workflow: SpecWorkflow | undefined,
  blocked: string | undefined
): SpecStart | undefined => {
  if (start === "code" || !workflow || blocked) {
    return undefined;
  }
  return start === "explore" && !workflow.explore ? undefined : start;
};

const promptPlaceholder = (spec: SpecStart | undefined): string => {
  if (spec === "explore") {
    return "What should you and the agent think through?";
  }
  return spec === "propose"
    ? "What should the change propose?"
    : "What should the agent do?";
};

/** A draft's variant as the form holds it. */
const variantToRow = (v: TaskVariantSpec): VariantRow => ({
  agent: v.agent ?? "",
  model: modelKey(v.model),
  variant: v.model?.variant ?? "",
});

const startLabel = (busy: boolean, variants: number): string => {
  if (busy) {
    return "Starting…";
  }
  return variants > 1 ? `Start ${variants} variants` : "Start task";
};
