import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { branchSlug, deriveTitle, MAX_VARIANTS, taskBranches } from "../../shared/tasks";
import type { ModelsInfo, TaskVariantSpec, TaskWhere } from "../../shared/types";
import { createTask, fetchModels } from "../api";
import { useDash } from "../DashboardContext";
import { modelFromKey, modelKey, taskDestination, taskFailures } from "../tasks";
import { Icon } from "./Icon";
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
  // Mounted per opening, so every field starts empty.
  return <Dialog initialProject={newTaskFor.projectId} onClose={closeNewTask} />;
}

function Dialog({ initialProject, onClose }: { initialProject?: string; onClose: () => void }) {
  const { snapshot, act, report } = useDash();
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
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [where, setWhere] = useState<TaskWhere>("worktree");
  const [rows, setRows] = useState<Row[]>([EMPTY_ROW]);
  const [models, setModels] = useState<ModelsInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const view = projects.find((v) => v.project.id === projectId);
  const flags = view ? projectFlags(view, (snapshot?.preflight.errors.length ?? 0) > 0) : undefined;
  const canOpen = flags?.canOpen ?? false;
  const worktreesReady = view?.runtime.worktreeRoot?.mounted === true;
  const effectiveWhere: TaskWhere = worktreesReady ? where : "workspace";
  const shownRows = effectiveWhere === "worktree" ? rows : rows.slice(0, 1);
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

  useEffect(() => {
    promptRef.current?.focus();
  }, []);

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
    const model = modelFromKey(r.model);
    return {
      ...(model ? { model: { ...model, ...(r.variant ? { variant: r.variant } : {}) } } : {}),
      ...(r.agent ? { agent: r.agent } : {}),
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
      ...(title.trim() ? { title: title.trim() } : {}),
      where: effectiveWhere,
      ...(worktree && branch.trim() ? { branch: branch.trim() } : {}),
      ...(worktree && base.trim() ? { base: base.trim() } : {}),
      variants,
    })
      .then(
        (result) => {
          const to = taskDestination(view.project.id, result);
          const failed = taskFailures(result);
          if (!to) {
            setError(failed ?? "No variant started");
            return;
          }
          onClose();
          void navigate(to);
          if (failed) report(new Error(`Some variants did not start: ${failed}`));
        },
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <form
        className="dialog task-dialog"
        role="dialog"
        aria-label="New task"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={submit}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="dialog-head">
          <h2>New task</h2>
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>

        <label className="field">
          <span>Project</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((v) => (
              <option key={v.project.id} value={v.project.id}>
                {v.project.name}
              </option>
            ))}
          </select>
        </label>

        {view && !canOpen && (
          <div className="note note-warn task-start">
            <span>
              {flags?.transitioning
                ? "Starting the project…"
                : flags?.unhealthy
                  ? "opencode is not responding. Restart it from the project's menu."
                  : "The project isn't running. Start it to run a task."}
            </span>
            {!flags?.transitioning && !flags?.unhealthy && (
              <button type="button" disabled={flags?.locked} onClick={() => act(view.project.id, "start")}>
                <Icon name="play" size={12} /> Start project
              </button>
            )}
          </div>
        )}

        <label className="field">
          <span>Prompt</span>
          <textarea
            ref={promptRef}
            rows={6}
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
        </label>

        <fieldset className="task-where">
          <legend>Where</legend>
          <label>
            <input type="radio" name="where" checked={effectiveWhere === "worktree"} disabled={!worktreesReady} onChange={() => setWhere("worktree")} />{" "}
            New worktree
          </label>
          <label>
            <input type="radio" name="where" checked={effectiveWhere === "workspace"} onChange={() => setWhere("workspace")} /> Main checkout
          </label>
          {view && canOpen && !worktreesReady && <span className="muted">Rebuild the container to enable worktrees.</span>}
        </fieldset>

        <div className="task-variants">
          {shownRows.map((row, i) => {
            const chosen = models?.models.find((m) => modelKey(m) === row.model);
            return (
              <div className="task-variant" key={i}>
                <select aria-label={`Model ${i + 1}`} value={row.model} onChange={(e) => setRow(i, { model: e.target.value, variant: "" })}>
                  <option value="">{defaultName ? `Default (${defaultName})` : "Default model"}</option>
                  {models?.models.map((m) => (
                    <option key={modelKey(m)} value={modelKey(m)}>
                      {m.name}
                    </option>
                  ))}
                </select>
                {chosen && chosen.variants.length > 0 && (
                  <select aria-label={`Reasoning ${i + 1}`} value={row.variant} onChange={(e) => setRow(i, { variant: e.target.value })}>
                    <option value="">Default effort</option>
                    {chosen.variants.map((v) => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                )}
                {models && models.agents.length > 1 && (
                  <select aria-label={`Agent ${i + 1}`} value={row.agent} onChange={(e) => setRow(i, { agent: e.target.value })}>
                    <option value="">Default agent</option>
                    {models.agents.map((a) => (
                      <option key={a.id} value={a.id} title={a.description}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
                {shownRows.length > 1 && (
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove model ${i + 1}`}
                    onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                  >
                    <Icon name="close" size={14} />
                  </button>
                )}
              </div>
            );
          })}
          {effectiveWhere === "worktree" && rows.length < MAX_VARIANTS && (
            <button type="button" className="link" onClick={() => setRows((rs) => [...rs, EMPTY_ROW])}>
              <Icon name="plus" size={12} /> Compare with another model
            </button>
          )}
        </div>

        <details className="task-options">
          <summary>Options</summary>
          <label className="field">
            <span>Title</span>
            <input value={title} maxLength={200} placeholder={deriveTitle(prompt) || "First line of the prompt"} onChange={(e) => setTitle(e.target.value)} />
          </label>
          {effectiveWhere === "worktree" && (
            <>
              <label className="field">
                <span>Branch</span>
                <input value={branch} placeholder={branchSlug(shownTitle)} onChange={(e) => setBranch(e.target.value)} />
              </label>
              <label className="field">
                <span>Base</span>
                <input value={base} placeholder="the main checkout's current branch" onChange={(e) => setBase(e.target.value)} />
              </label>
            </>
          )}
        </details>

        {preview.length > 0 && (
          <p className="muted task-preview">
            {preview.length === 1 ? "Branch" : "Branches"}: <code>{preview.join(", ")}</code>
            {!branch.trim() || preview.length > 1 ? " — a number is added when one is taken" : ""}
          </p>
        )}

        {error && <div className="banner error">{error}</div>}

        <div className="dialog-actions">
          <span className="muted">{isMac ? "⌘" : "Ctrl"}+Enter to start</span>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!view || !prompt.trim() || !canOpen || busy}>
            {busy ? "Starting…" : variants.length > 1 ? `Start ${variants.length} variants` : "Start task"}
          </button>
        </div>
      </form>
    </div>
  );
}
