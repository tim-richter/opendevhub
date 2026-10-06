import { useEffect, useState } from "react";
import type { CheckDef, ChecksConfig, CheckWhere } from "../../shared/types";
import { fetchChecks, saveChecks } from "../api";
import { MonitorIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Choice } from "./Choice";
import { Chip, muted, Section } from "./Page";

const DEFAULT_TIMEOUT = 900;

const SOURCE_LABEL: Record<ChecksConfig["source"], string> = {
  devcontainer: "from devcontainer.json",
  settings: "your settings for this project",
  none: "none yet",
};

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Row = { key: number; name: string; command: string; where: CheckWhere; timeout: string };

let nextKey = 1;
const toRow = (c: CheckDef): Row => ({ key: nextKey++, name: c.name, command: c.command, where: c.where, timeout: String(c.timeout) });

/** The project's checks on its page: what Review runs, and where to change it. */
export function ChecksSettings({ projectId }: { projectId: string }) {
  const [config, setConfig] = useState<ChecksConfig>();
  const [error, setError] = useState<string>();
  const [rows, setRows] = useState<Row[]>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchChecks(projectId).then(setConfig, (err: unknown) => setError(message(err)));
  }, [projectId]);

  const save = (checks: CheckDef[] | null) => {
    setSaving(true);
    saveChecks(projectId, checks)
      .then(
        (c) => {
          setConfig(c);
          setRows(undefined);
          setError(undefined);
        },
        (err: unknown) => setError(message(err)),
      )
      .finally(() => setSaving(false));
  };
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs?.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  return (
    <Section
      title="Checks"
      hint={config ? `run from Review before publishing · ${SOURCE_LABEL[config.source]}` : "run from Review before publishing"}
      action={
        config &&
        !rows && (
          <Button variant="ghost" size="sm" onClick={() => setRows(config.checks.map(toRow))}>
            <PencilIcon /> Edit
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {config?.errors.map((e) => (
          <p key={e} className="text-sm text-warn">
            {e}
          </p>
        ))}
        {!config && !error && <p className={muted}>Loading…</p>}

        {config && !rows && config.checks.length === 0 && (
          <p className={muted}>
            No checks. Add the commands a change must pass (tests, lint, a Docker build) here, or under{" "}
            <code className="font-mono">customizations.opendevhub.checks</code> in devcontainer.json to share them with the team.
          </p>
        )}
        {config && !rows && config.checks.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {config.checks.map((c) => (
              <li key={c.name} className="flex min-w-0 items-center gap-2 text-sm">
                <span className="font-medium">{c.name}</span>
                {c.where === "host" && (
                  <Chip className="gap-1" title="Runs on this machine">
                    <MonitorIcon className="size-3" /> host
                  </Chip>
                )}
                <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={c.command}>
                  {c.command}
                </code>
                {c.timeout !== DEFAULT_TIMEOUT && <span className="shrink-0 text-xs text-muted-foreground">{c.timeout} s</span>}
                {c.where === "host" && !c.approved && <span className="ml-auto shrink-0 text-xs text-warn">needs approval on first run</span>}
              </li>
            ))}
          </ul>
        )}

        {rows && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              save(rows.map((r) => ({ name: r.name.trim(), command: r.command.trim(), where: r.where, timeout: Number(r.timeout) || DEFAULT_TIMEOUT })));
            }}
          >
            {rows.map((r) => (
              <div key={r.key} className="grid grid-cols-[8rem_minmax(0,1fr)_7.5rem_5.5rem_auto] items-center gap-2 max-md:grid-cols-[minmax(0,1fr)_auto] max-md:border-b max-md:pb-3">
                <Input aria-label="Name" placeholder="name" value={r.name} onChange={(e) => update(r.key, { name: e.target.value })} className="h-8" />
                <Input
                  aria-label="Command"
                  placeholder="pnpm test"
                  value={r.command}
                  onChange={(e) => update(r.key, { command: e.target.value })}
                  className="h-8 font-mono text-xs max-md:col-span-2 max-md:row-start-2"
                />
                <Choice
                  label="Where it runs"
                  value={r.where}
                  onChange={(v) => update(r.key, { where: v as CheckWhere })}
                  options={[
                    { value: "container", label: "Container" },
                    { value: "host", label: "This machine", title: "For docker build / docker compose: runs in the checkout's folder on this machine" },
                  ]}
                  className="max-md:row-start-3"
                />
                <Input
                  aria-label="Timeout in seconds"
                  title="Timeout in seconds"
                  type="number"
                  min={10}
                  max={7200}
                  value={r.timeout}
                  onChange={(e) => update(r.key, { timeout: e.target.value })}
                  className="h-8 max-md:row-start-3"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${r.name || "check"}`}
                  className="text-muted-foreground max-md:col-start-2 max-md:row-start-1"
                  onClick={() => setRows((rs) => rs?.filter((x) => x.key !== r.key))}
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setRows((rs) => [...(rs ?? []), { key: nextKey++, name: "", command: "", where: "container", timeout: String(DEFAULT_TIMEOUT) }])}
              >
                <PlusIcon /> Add check
              </Button>
              <span className="flex-1" />
              {config?.source === "settings" && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  title={config.devcontainer.length > 0 ? `Use the ${config.devcontainer.length} from devcontainer.json` : "devcontainer.json has none"}
                  onClick={() => save(null)}
                >
                  Use devcontainer.json
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => setRows(undefined)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
            <p className={muted}>
              Saved in your opendevhub config for this project and used instead of devcontainer.json. Commands you save here that run on this
              machine count as approved.
            </p>
          </form>
        )}
      </div>
    </Section>
  );
}
