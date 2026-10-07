import { ChevronDownIcon, CodeXmlIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { ProjectView } from "../../shared/types";
import { openInEditor } from "../api";
import { useDash } from "../DashboardContext";
import { containerShellCommand, shellQuote } from "../derive";
import { Tip } from "./Tip";

/**
 * "Open in…" for one checkout (the workspace or a worktree): editors opendevhub found on this machine,
 * plus commands to copy for anything it can't launch (a terminal Neovim, a shell in the container).
 */
/** `icon` draws the trigger as an icon button with a tooltip. */
export const OpenInMenu = (props: {
  view: ProjectView;
  directory: string;
  hostPath?: string;
  compact?: boolean;
  icon?: boolean;
}) => {
  const { view, directory, hostPath, compact, icon } = props;
  const { snapshot, report } = useDash();
  const running = view.runtime.containerState === "running";
  const editors = snapshot?.editors ?? [];
  const shell = running ? containerShellCommand(view, directory) : undefined;

  const launch = (editor: string) => () =>
    void openInEditor(view.project.id, editor, directory).catch(report);
  const copy = (text: string) => () =>
    void navigator.clipboard?.writeText(text).catch(report);
  // Disabled menu items swallow hover, so the reason is shown inline rather than as a tooltip.
  const why = (target: "host" | "container") => {
    if (target === "host") {
      return hostPath ? undefined : "not on this machine";
    }
    return running && view.runtime.containerName
      ? undefined
      : "container stopped";
  };
  const item = (
    label: string,
    reason: string | undefined,
    onSelect: () => void,
    key?: string
  ) => (
    <DropdownMenuItem key={key} disabled={!!reason} onSelect={onSelect}>
      {label}
      {reason && (
        <span className="text-muted-foreground ml-auto pl-4 text-xs">
          {reason}
        </span>
      )}
    </DropdownMenuItem>
  );
  const note = "max-w-68 px-2 py-1.5 text-xs text-muted-foreground";

  return (
    <DropdownMenu>
      {icon ? (
        <Tip label="Open in…">
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" aria-label="Open in…">
              <CodeXmlIcon />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
      ) : (
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size={compact ? "sm" : "default"}
            onClick={(e) => e.stopPropagation()}
          >
            Open in… <ChevronDownIcon />
          </Button>
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent
        align="end"
        className="min-w-56"
        onClick={(e) => e.stopPropagation()}
      >
        {editors.length > 0 && (
          <DropdownMenuLabel className="text-muted-foreground text-xs">
            Editors on this machine
          </DropdownMenuLabel>
        )}
        {editors.map((e) => item(e.label, why(e.target), launch(e.id), e.id))}
        {editors.length === 0 && (
          <p className={note}>
            No supported editor found on PATH (VS Code, Zed, JetBrains, Neovim…)
          </p>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          Copy
        </DropdownMenuLabel>
        {item(
          hostPath ? "Path" : "Path in container",
          undefined,
          copy(hostPath ?? directory)
        )}
        {item(
          "Neovim command",
          why("host"),
          copy(`cd ${shellQuote(hostPath ?? "")} && nvim .`)
        )}
        {item(
          "Shell in container command",
          shell ? undefined : why("container"),
          copy(shell ?? "")
        )}
        {!hostPath && (
          <p className={note}>
            This checkout only exists inside the container. Rebuild the
            container to mount worktrees on this machine.
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
