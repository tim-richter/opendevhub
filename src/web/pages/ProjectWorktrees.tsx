import { type FormEvent, useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router";
import type { ProjectView } from "../../shared/types";
import { createWorktree, refreshWorktrees, removeWorktree, startSession } from "../api";
import { CopyButton } from "../components/CopyButton";
import { Icon } from "../components/Icon";
import { OpenInMenu } from "../components/OpenInMenu";
import { openSessionTab, projectFlags } from "../components/ProjectActions";
import { useDash } from "../DashboardContext";
import { workspaceFolderOf } from "../derive";
import { targetOf } from "../review";

export function ProjectWorktrees() {
  const view = useOutletContext<ProjectView>();
  const { act, report, snapshot } = useDash();
  const { project, runtime } = view;
  const { running, canOpen, locked } = projectFlags(view, (snapshot?.preflight.errors.length ?? 0) > 0);
  const [branch, setBranch] = useState("");
  const [base, setBase] = useState("");
  const [withSession, setWithSession] = useState(true);
  const [pending, setPending] = useState<string>();
  const root = runtime.worktreeRoot;
  const mounted = running && root?.mounted === true;
  const worktrees = runtime.worktrees ?? [];
  const ws = workspaceFolderOf(view);

  // Pick up worktrees made outside opendevhub (by opencode or a shell) when the tab opens.
  useEffect(() => {
    if (running) void refreshWorktrees(project.id).catch(() => {});
  }, [project.id, running]);

  const busy = (key: string, fn: () => Promise<unknown>) => {
    setPending(key);
    void fn()
      .catch(report)
      .finally(() => setPending(undefined));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const req = { branch, base: base || undefined, startSession: withSession && canOpen };
    const create = async () => {
      const res = await createWorktree(project.id, req);
      setBranch("");
      setBase("");
      return res.sessionId;
    };
    busy("create", () => (req.startSession ? openSessionTab(view, create) : create()));
  };

  const remove = (path: string, name: string) => {
    if (!confirm(`Remove the worktree ${name}? Its folder is deleted; the branch is kept.`)) return;
    busy(path, async () => {
      try {
        await removeWorktree(project.id, path, false);
      } catch (err) {
        if (!(err instanceof Error) || !/--force/.test(err.message)) throw err;
        if (!confirm(`${name} has uncommitted or untracked changes. Remove it anyway and discard them?`)) return;
        await removeWorktree(project.id, path, true);
      }
    });
  };

  const newSession = (directory: string, title?: string) =>
    busy(`session:${directory}`, () => openSessionTab(view, () => startSession(project.id, directory, title)));

  const sessionsIn = (dir: string) => view.sessions.filter((s) => s.directory === dir).length;

  return (
    <div className="tab-body">
      {!running && (
        <p className="note">Start the project to create worktrees. Worktrees on this machine can still be opened.</p>
      )}
      {running && root && !root.mounted && (
        <div className="note note-warn wt-head">
          <span>
            This container was created before opendevhub mounted <code>{root.host}</code>. Rebuild it to create
            worktrees you can open on this machine.
          </span>
          <button
            className="small"
            disabled={locked}
            onClick={() => {
              if (confirm(`Rebuild the devcontainer for ${project.name}? Running sessions will be interrupted.`))
                act(project.id, "rebuild");
            }}
          >
            Rebuild container
          </button>
        </div>
      )}

      {mounted && (
        <form className="wt-form" onSubmit={submit}>
          <input
            type="text"
            placeholder="Branch, e.g. feature/login"
            aria-label="Branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            required
          />
          <input
            type="text"
            placeholder="From (default: current HEAD)"
            aria-label="Base"
            value={base}
            onChange={(e) => setBase(e.target.value)}
          />
          <label className="toggle" title={canOpen ? undefined : "opencode is not running"}>
            <input type="checkbox" checked={withSession && canOpen} disabled={!canOpen} onChange={(e) => setWithSession(e.target.checked)} />
            Start a session
          </label>
          <button type="submit" className="button primary" disabled={!branch.trim() || pending === "create"}>
            <Icon name="plus" size={14} /> {pending === "create" ? "Creating…" : "New worktree"}
          </button>
        </form>
      )}

      <div className="wt-head">
        <span className="muted">
          {root?.mounted ? (
            <>
              Worktrees live in <code>{root.host}</code>, mounted at <code>{root.container}</code>.
            </>
          ) : root ? (
            "Worktrees made inside the container (by opencode or a shell) are listed below."
          ) : (
            "Worktrees appear here once the project has started."
          )}
        </span>
        {running && (
          <button className="small ghost" disabled={!!pending} onClick={() => busy("refresh", () => refreshWorktrees(project.id))}>
            <Icon name="refresh" size={13} /> Refresh
          </button>
        )}
      </div>

      {/* Visible overflow so the "Open in…" menus aren't clipped by the table frame. */}
      <div className="table-wrap wt-table">
        <table className="table">
          <thead>
            <tr>
              <th>Checkout</th>
              <th>On this machine</th>
              <th>Sessions</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>Main checkout</strong>
              </td>
              <td className="mono" title={project.path}>
                <span className="wt-path">{project.path}</span> <CopyButton text={project.path} label="Copy path" />
              </td>
              <td>{sessionsIn(ws) || "—"}</td>
              <td>
                <div className="wt-actions">
                  <Link className="button small" to={`/p/${encodeURIComponent(project.id)}/review`}>
                    Review
                  </Link>
                  <button className="small" disabled={!canOpen || !!pending} onClick={() => newSession(ws)}>
                    New session
                  </button>
                  <OpenInMenu view={view} directory={ws} hostPath={project.path} compact />
                  <span className="icon-spacer" />
                </div>
              </td>
            </tr>
            {worktrees.map((w) => {
              const name = w.branch ?? w.path.split("/").at(-1) ?? w.path;
              return (
                <tr key={w.path}>
                  <td>
                    <span className="chip">
                      <Icon name="branch" size={11} /> {name}
                    </span>
                  </td>
                  <td className="mono" title={w.hostPath ?? w.path}>
                    {w.hostPath ? (
                      <>
                        <span className="wt-path">{w.hostPath}</span> <CopyButton text={w.hostPath} label="Copy path" />
                      </>
                    ) : (
                      <span className="wt-path muted">only in container ({w.path})</span>
                    )}
                  </td>
                  <td>{sessionsIn(w.path) || "—"}</td>
                  <td>
                    <div className="wt-actions">
                      {targetOf(view, w.path) !== undefined && (
                        <Link className="button small" to={`/p/${encodeURIComponent(project.id)}/review/${encodeURIComponent(targetOf(view, w.path)!)}`}>
                          Review
                        </Link>
                      )}
                      <button className="small" disabled={!canOpen || !!pending} onClick={() => newSession(w.path, w.branch)}>
                        New session
                      </button>
                      <OpenInMenu view={view} directory={w.path} hostPath={w.hostPath} compact />
                      <button
                        className="icon-button"
                        aria-label={`Remove worktree ${name}`}
                        title="Remove worktree"
                        disabled={!running || !!pending}
                        onClick={() => remove(w.path, name)}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {worktrees.length === 0 && root && <p className="muted">No worktrees yet.</p>}
    </div>
  );
}
