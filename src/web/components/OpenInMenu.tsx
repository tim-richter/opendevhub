import type { ProjectView } from "../../shared/types";
import { openInEditor } from "../api";
import { useDash } from "../DashboardContext";
import { containerShellCommand, shellQuote } from "../derive";
import { Icon } from "./Icon";
import { useMenu } from "./ProjectActions";

/**
 * "Open in…" for one checkout (the workspace or a worktree): editors opendevhub found on this machine,
 * plus commands to copy for anything it can't launch (a terminal Neovim, a shell in the container).
 */
export function OpenInMenu(props: { view: ProjectView; directory: string; hostPath?: string; compact?: boolean }) {
  const { view, directory, hostPath, compact } = props;
  const { snapshot, report } = useDash();
  const { open, setOpen, ref, run } = useMenu();
  const running = view.runtime.containerState === "running";
  const editors = snapshot?.editors ?? [];
  const shell = running ? containerShellCommand(view, directory) : undefined;

  const launch = (editor: string) => () => void openInEditor(view.project.id, editor, directory).catch(report);
  const copy = (text: string) => () => void navigator.clipboard?.writeText(text).catch(report);
  // Disabled menu items swallow hover, so the reason is shown inline rather than as a tooltip.
  const why = (target: "host" | "container") =>
    target === "host"
      ? hostPath
        ? undefined
        : "not on this machine"
      : running && view.runtime.containerName
        ? undefined
        : "container stopped";
  const item = (label: string, reason: string | undefined, onClick: () => void, key?: string) => (
    <button key={key} role="menuitem" disabled={!!reason} onClick={run(onClick)}>
      {label}
      {reason && <span className="menu-hint">{reason}</span>}
    </button>
  );

  return (
    <div className="menu" ref={ref}>
      <button
        className={compact ? "small" : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        Open in… <Icon name="chevron-down" size={12} />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          {editors.length > 0 && <div className="menu-label">Editors on this machine</div>}
          {editors.map((e) => item(e.label, why(e.target), launch(e.id), e.id))}
          {editors.length === 0 && (
            <div className="menu-note muted">No supported editor found on PATH (VS Code, Zed, JetBrains, Neovim…)</div>
          )}
          <div className="menu-sep" role="separator" />
          <div className="menu-label">Copy</div>
          {item(hostPath ? "Path" : "Path in container", undefined, copy(hostPath ?? directory))}
          {item("Neovim command", why("host"), copy(`cd ${shellQuote(hostPath ?? "")} && nvim .`))}
          {item("Shell in container command", shell ? undefined : why("container"), copy(shell ?? ""))}
          {!hostPath && (
            <div className="menu-note muted">
              This checkout only exists inside the container. Rebuild the container to mount worktrees on this machine.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
