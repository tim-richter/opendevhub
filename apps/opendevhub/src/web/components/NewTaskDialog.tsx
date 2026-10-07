import { jiraTaskPrompt } from "../../shared/jira";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { branchSlug, deriveTitle, MAX_VARIANTS, taskBranches } from "../../shared/tasks";
import type { Isolation, ModelsInfo, TaskVariantSpec, TaskWhere } from "../../shared/types";
import { createTask, fetchModels } from "../api";
import { useDash, type NewTaskDraft } from "../DashboardContext";
import { nodeChoices } from "../nodes";
import { modelFromKey, modelKey, taskPath } from "../tasks";
import { ChevronRightIcon, PlayIcon, PlusIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { Choice } from "./Choice";
import { projectFlags } from "./ProjectActions";

interface Row {
  model: string;
  variant: string;
  agent: string;
}
const EMPTY_ROW: Row = { model: "", variant: "", agent: "" };

export function NewTaskDialog() {
  const { snapshot, newTaskFor, closeNewTask } = useDash();
  if (!snapshot || !newTaskFor) return null;
  // Mounted per opening, with integration context prefilled when provided.
  return <TaskForm initialProject={newTaskFor.projectId} draft={newTaskFor} onClose={closeNewTask} />;
}

function TaskForm({ initialProject, draft, onClose }: { initialProject?: string; draft?: NewTaskDraft; onClose: () => void }) {
  const { snapshot, act } = useDash();
  const jira = draft?.jira;
  const navigate = useNavigate();
  const projects = useMemo(
    () => [...(snapshot?.projects ?? [])].sort((a, b) => a.project.name.localeCompare(b.project.name)),
    [snapshot],
  );
  const [projectId, setProjectId] = useState(
    () =>
      initialProject ??
      projects.find((v) => v.runtime.containerState === "running")?.project.id ??
      projects[0]?.project.id ??
      "",
  );
  const [prompt, setPrompt] = useState(() => draft?.prompt ?? (jira ? jiraTaskPrompt(jira) : ""));
  const [title, setTitle] = useState(() => draft?.title ?? (jira ? `${jira.key}: ${jira.title}`.slice(0, 200) : ""));
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState(draft?.base ?? "");
  const [where, setWhere] = useState<TaskWhere>("worktree");
  const [environment, setEnvironment] = useState<Isolation>();
  const [node, setNode] = useState("local");
  const [rows, setRows] = useState<Row[]>([EMPTY_ROW]);
  const [models, setModels] = useState<ModelsInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const view = projects.find((v) => v.project.id === projectId);
  const nodes = snapshot?.nodes ?? [];
  const remote = node !== "local";
  const flags = view ? projectFlags(view, (snapshot?.preflight.errors.length ?? 0) > 0) : undefined;
  const canOpen = flags?.canOpen ?? false;
  const worktreesReady = view?.runtime.worktreeRoot?.mounted === true;
  const effectiveWhere: TaskWhere = remote ? "worktree" : worktreesReady ? where : "workspace";
  const isolation = view?.isolation;
  const chosenEnv: Isolation = remote ? "isolated" : isolation?.unsupported ? "shared" : (environment ?? isolation?.default ?? "shared");
  const shownRows = effectiveWhere === "worktree" ? rows : rows.slice(0, 1);
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

  useEffect(() => {
    setModels(undefined);
    if (!canOpen || !projectId) return;
    let live = true;
    fetchModels(projectId).then(
      (m) => live && setModels(m),
      () => live && setModels({ models: [], agents: [] }),
    );
    return () => {
      live = false;
    };
  }, [projectId, canOpen]);

  const variants: TaskVariantSpec[] = shownRows.map((r) => {
    // Only what the current project's lists offer, so what is sent matches what is shown.
    const chosen = models?.models.find((m) => modelKey(m) === r.model);
    const model = chosen ? modelFromKey(r.model) : undefined;
    const variant = chosen?.variants.includes(r.variant) ? r.variant : "";
    const agent = models?.agents.some((a) => a.id === r.agent) ? r.agent : "";
    return {
      ...(model ? { model: { ...model, ...(variant ? { variant } : {}) } } : {}),
      ...(agent ? { agent } : {}),
    };
  });
  const shownTitle = title.trim() || deriveTitle(prompt);
  const preview =
    effectiveWhere === "worktree" && shownTitle ? taskBranches({ branch: branch.trim() || undefined, title: shownTitle, variants }) : [];
  const defaultModel = models?.default;
  const defaultName = defaultModel
    ? (models?.models.find((m) => m.id === defaultModel.id && m.providerID === defaultModel.providerID)?.name ?? defaultModel.id)
    : undefined;
  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!view || !prompt.trim() || !canOpen || busy) return;
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
      variants,
    })
      .then(
        (result) => {
          // The variants are set up in the background; the task's page shows how far each one got.
          onClose();
          void navigate(taskPath(view.project.id, result.task));
        },
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
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
          <DialogTitle>{jira ? `New task from ${jira.key}` : "New task"}</DialogTitle>
          <DialogDescription className="sr-only">Start an agent on a prompt in one of your projects.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="task-project">Project</Label>
            <Choice
              id="task-project"
              size="default"
              className="w-full"
              value={projectId}
              options={projects.map((v) => ({ value: v.project.id, label: v.project.name }))}
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
              <AlertDescription className="flex items-center justify-between gap-2 text-warn">
                <span>
                  {flags?.transitioning
                    ? "Starting the project…"
                    : flags?.unhealthy
                      ? "opencode is not responding. Restart it from the project's menu."
                      : "The project isn't running. Start it to run a task."}
                </span>
                {!flags?.transitioning && !flags?.unhealthy && (
                  <Button type="button" variant="outline" size="sm" disabled={flags?.locked} onClick={() => act(view.project.id, "start")}>
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
              placeholder="What should the agent do?"
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </div>

          {nodes.length > 1 && (
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <Label htmlFor="task-node" className="font-normal text-muted-foreground">
                Node
              </Label>
              <Choice id="task-node" value={node} options={nodeChoices(nodes)} onChange={setNode} />
              {remote && (
                <span className="text-muted-foreground">
                  {isolation?.unsupported ?? "Runs in a new worktree with its own container, from the base pushed to that node."}
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
                <RadioGroupItem value="worktree" disabled={remote || !worktreesReady} /> New worktree
              </Label>
              <Label className="font-normal">
                <RadioGroupItem value="workspace" disabled={remote} /> Main checkout
              </Label>
            </RadioGroup>
            {view && canOpen && !worktreesReady && <span className="text-muted-foreground">Rebuild the container to enable worktrees.</span>}
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
                  <RadioGroupItem value="shared" disabled={remote} /> Shared container
                </Label>
                <Label className="font-normal" title={isolation?.unsupported}>
                  <RadioGroupItem value="isolated" disabled={remote || !!isolation?.unsupported} /> Own container
                </Label>
              </RadioGroup>
              {isolation?.unsupported && <span className="text-muted-foreground">{isolation.unsupported}</span>}
            </div>
          )}

          <div className="flex flex-col items-start gap-2">
            {shownRows.map((row, i) => {
              const chosen = models?.models.find((m) => modelKey(m) === row.model);
              return (
                <div className="flex flex-wrap items-center gap-2" key={i}>
                  <Choice
                    label={`Model ${i + 1}`}
                    value={row.model}
                    onChange={(model) => setRow(i, { model, variant: "" })}
                    options={[
                      { value: "", label: defaultName ? `Default (${defaultName})` : "Default model" },
                      ...(models?.models.map((m) => ({ value: modelKey(m), label: m.name })) ?? []),
                    ]}
                  />
                  {chosen && chosen.variants.length > 0 && (
                    <Choice
                      label={`Reasoning ${i + 1}`}
                      value={row.variant}
                      onChange={(variant) => setRow(i, { variant })}
                      options={[{ value: "", label: "Default effort" }, ...chosen.variants.map((v) => ({ value: v, label: v }))]}
                    />
                  )}
                  {models && models.agents.length > 1 && (
                    <Choice
                      label={`Agent ${i + 1}`}
                      value={row.agent}
                      onChange={(agent) => setRow(i, { agent })}
                      options={[
                        { value: "", label: "Default agent" },
                        ...models.agents.map((a) => ({ value: a.id, label: a.name, title: a.description })),
                      ]}
                    />
                  )}
                  {shownRows.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-muted-foreground"
                      aria-label={`Remove model ${i + 1}`}
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                    >
                      <XIcon />
                    </Button>
                  )}
                </div>
              );
            })}
            {effectiveWhere === "worktree" && rows.length < MAX_VARIANTS && (
              <Button type="button" variant="link" size="sm" className="px-0" onClick={() => setRows((rs) => [...rs, EMPTY_ROW])}>
                <PlusIcon /> Compare with another model
              </Button>
            )}
          </div>

          <Collapsible className="group/options flex flex-col gap-3">
            <CollapsibleTrigger className="flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground">
              <ChevronRightIcon className="size-4 transition-transform group-data-[state=open]/options:rotate-90" /> Options
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-3">
              <div className="grid gap-2">
                <Label htmlFor="task-title">Title</Label>
                <Input
                  id="task-title"
                  value={title}
                  maxLength={200}
                  placeholder={deriveTitle(prompt) || "First line of the prompt"}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              {effectiveWhere === "worktree" && (
                <>
                  <div className="grid gap-2">
                    <Label htmlFor="task-branch">Branch</Label>
                    <Input id="task-branch" value={branch} placeholder={branchSlug(shownTitle)} onChange={(e) => setBranch(e.target.value)} />
                  </div>
                  <div className="grid gap-2">
                    <Label htmlFor="task-base">Base</Label>
                    <Input id="task-base" value={base} placeholder="the main checkout's current branch" onChange={(e) => setBase(e.target.value)} />
                  </div>
                </>
              )}
            </CollapsibleContent>
          </Collapsible>

          {preview.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {preview.length === 1 ? "Branch" : "Branches"}: <code className="font-mono">{preview.join(", ")}</code>
              {!branch.trim() || preview.length > 1 ? " — a number is added when one is taken" : ""}
            </p>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter className="items-center">
            <span className="mr-auto text-xs text-muted-foreground">{isMac ? "⌘" : "Ctrl"}+Enter to start</span>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!view || !prompt.trim() || !canOpen || busy}>
              {busy ? "Starting…" : variants.length > 1 ? `Start ${variants.length} variants` : "Start task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
