import { useLocation } from "@tanstack/react-router";
import { BookOpenIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useState } from "react";
import type { FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { saveRoots } from "../../api";
import { Note } from "../../components/page";
import { useDash } from "../../dashboard-context";
import { SettingsBlock, SettingsHeader, SettingsList } from "./settings-layout";

const DOCS_URL = "https://tim-richter.github.io/opendevhub/";

const ProjectFolders = () => {
  const { snapshot, rescan, scanning } = useDash();
  const location = useLocation();
  const roots = snapshot?.roots ?? [];
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async (next: string[]): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    try {
      await saveRoots(next);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const folder = draft.trim();
    if (folder && (await save([...roots, folder]))) {
      setDraft("");
    }
  };

  return (
    <SettingsBlock
      id="roots"
      title="Project folders"
      hint="Folders opendevhub scans for projects: git repos with a devcontainer, up to two levels down."
      action={
        <Button
          variant="outline"
          size="sm"
          disabled={scanning || busy}
          onClick={rescan}
        >
          <RefreshCwIcon className={scanning ? "animate-spin" : undefined} />
          {scanning ? "Scanning…" : "Rescan"}
        </Button>
      }
    >
      {roots.length > 0 ? (
        <SettingsList>
          {roots.map((root) => (
            <li
              key={root}
              className="flex items-center gap-2 py-1 pr-1 pl-3 font-mono text-xs"
            >
              <span className="min-w-0 flex-1 truncate" title={root}>
                {root}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label={`Remove ${root}`}
                onClick={() => void save(roots.filter((r) => r !== root))}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </SettingsList>
      ) : (
        <p className="text-muted-foreground text-sm">
          No folders yet. Add the folder that holds your git repos.
        </p>
      )}
      <form className="flex flex-col gap-1.5" onSubmit={(e) => void add(e)}>
        <Label htmlFor="roots-add">Add folder</Label>
        <div className="flex gap-2">
          <Input
            id="roots-add"
            className="font-mono"
            placeholder="~/code"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            autoFocus={location.hash === "roots"}
          />
          <Button type="submit" disabled={busy || !draft.trim()}>
            <PlusIcon /> Add
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          An absolute path on this machine. Projects are found in its
          subfolders.
        </p>
      </form>
      {error && (
        <div role="alert">
          <Note error>{error}</Note>
        </div>
      )}
    </SettingsBlock>
  );
};

export const GeneralSettings = () => (
  <>
    <SettingsHeader
      title="General"
      description="Where opendevhub finds your projects."
    />
    <ProjectFolders />
    <SettingsBlock
      title="Documentation"
      hint="Setup guides, devcontainer tips and how tasks, worktrees and reviews fit together."
    >
      <div>
        <Button asChild variant="outline">
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer">
            <BookOpenIcon /> Open documentation
          </a>
        </Button>
      </div>
    </SettingsBlock>
  </>
);
