import { useLocation } from "@tanstack/react-router";
import {
  BookOpenIcon,
  CircleCheckIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";

import { confirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import type {
  IntegrationSettings,
  IntegrationSettingsInput,
} from "../../shared/integrations";
import { saveRoots, testForgejoConnection } from "../api";
import { Note, Page, PageHeader } from "../components/page";
import { useDash } from "../dashboard-context";

const DOCS_URL = "https://tim-richter.github.io/opendevhub/";

/** One settings topic: its name and purpose on the left, the controls on the right. */
const SettingsGroup = (props: {
  id?: string;
  title: string;
  hint: string;
  children: ReactNode;
}) => (
  <section
    id={props.id}
    className="grid gap-x-10 gap-y-4 border-t pt-6 md:grid-cols-[13rem_minmax(0,1fr)]"
  >
    <div className="flex flex-col gap-1">
      <h2 className="font-semibold">{props.title}</h2>
      <p className="text-muted-foreground text-sm">{props.hint}</p>
    </div>
    <div className="min-w-0">{props.children}</div>
  </section>
);

export const SettingsPage = () => {
  const { forgejo, forgejoError, updateForgejo, jira, jiraError, updateJira } =
    useDash();
  return (
    <Page>
      <PageHeader
        title="Settings"
        description="Project discovery and optional integrations."
      />
      <GeneralSection />
      <IntegrationSettingsForm
        name="Forgejo"
        hint="Your pull requests and their diffs"
        settings={forgejo}
        settingsError={forgejoError}
        update={updateForgejo}
        tokenHelp="Use a token with read:user, read:repository, and read:issue scopes, including private repositories you want to see."
      />
      <IntegrationSettingsForm
        name="Jira"
        hint="Assigned tickets and tasks"
        settings={jira}
        settingsError={jiraError}
        update={updateJira}
        tokenHelp="Use a personal access token from your self-hosted Jira Server or Data Center profile, with permission to browse the projects you need."
      />
    </Page>
  );
};

const IntegrationSettingsForm = ({
  name,
  hint,
  settings,
  settingsError,
  update,
  tokenHelp,
}: {
  name: "Forgejo" | "Jira";
  hint: string;
  settings?: IntegrationSettings;
  settingsError?: string;
  update: (input: IntegrationSettingsInput) => Promise<void>;
  tokenHelp: string;
}) => {
  const id = name.toLowerCase();
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [connection, setConnection] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const test = async () => {
    setTesting(true);
    setError(undefined);
    setConnection(undefined);
    try {
      const result = await testForgejoConnection({
        url,
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      setConnection(
        `Connected as ${result.username} · API ${result.version}. Read access verified.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };
  useEffect(() => {
    setConnection(undefined);
  }, [url, token]);

  useEffect(() => {
    if (!settings) {
      return;
    }
    setEnabled(settings.enabled);
    setUrl(settings.url);
    setToken("");
    setReplacing(false);
  }, [settings]);

  const save = async (e?: FormEvent, removeToken = false) => {
    e?.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    const trimmedToken = token.trim();
    let tokenPatch: { clearToken?: true; token?: string } = {};
    if (removeToken) {
      tokenPatch = { clearToken: true };
    } else if (trimmedToken) {
      tokenPatch = { token: trimmedToken };
    }
    try {
      await update({
        enabled: removeToken ? false : enabled,
        url,
        ...tokenPatch,
      });
      setToken("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const loading = !settings && !settingsError;

  return (
    <SettingsGroup title={name} hint={hint}>
      <form
        className="flex max-w-2xl flex-col gap-5"
        onSubmit={(e) => void save(e)}
      >
        <fieldset
          disabled={busy || testing || loading}
          className="flex flex-col gap-5 disabled:opacity-60"
        >
          <div className="flex items-center gap-3">
            <Switch
              id={`${id}-enabled`}
              checked={enabled}
              onCheckedChange={(value) => {
                setEnabled(value);
                setSaved(false);
              }}
            />
            <Label htmlFor={`${id}-enabled`}>Enable {name}</Label>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-url`}>{name} URL</Label>
            <Input
              id={`${id}-url`}
              type="url"
              placeholder={`https://${id}.example.com`}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setSaved(false);
              }}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-muted-foreground text-sm">
              The instance URL, including its path prefix if needed. Use HTTPS;
              local instances may use loopback HTTP.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-token`}>Access token</Label>
            {settings?.hasToken && !replacing ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-ok inline-flex items-center gap-1.5 text-sm">
                  <CircleCheckIcon className="size-4" /> Token saved
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setReplacing(true)}
                >
                  Replace
                </Button>
              </div>
            ) : (
              <Input
                id={`${id}-token`}
                type="password"
                value={token}
                onChange={(e) => {
                  setToken(e.target.value);
                  setSaved(false);
                }}
                placeholder={`Paste a ${name} access token`}
                autoComplete="new-password"
                spellCheck={false}
                autoFocus={replacing}
              />
            )}
            <p className="text-muted-foreground text-sm">
              {tokenHelp} Changing the URL requires a new token. Tokens live in
              your operating system&apos;s credential store, never in the
              settings file or the browser.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit">{busy ? "Saving…" : "Save"}</Button>
            {name === "Forgejo" && (
              <Button
                type="button"
                variant="outline"
                disabled={!url.trim()}
                onClick={() => void test()}
              >
                {testing ? "Testing…" : "Test connection"}
              </Button>
            )}
            {settings?.hasToken && (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive ml-auto"
                onClick={async () => {
                  if (
                    await confirm({
                      confirmLabel: "Remove token",
                      description: `${name} is turned off. You'll need a new token to turn it back on.`,
                      destructive: true,
                      title: `Remove the ${name} token?`,
                    })
                  ) {
                    void save(undefined, true);
                  }
                }}
              >
                Remove token…
              </Button>
            )}
          </div>
        </fieldset>
        {loading && (
          <p role="status" className="text-muted-foreground text-sm">
            Loading settings…
          </p>
        )}
        {(error || settingsError) && (
          <div role="alert">
            <Note error>{error || settingsError}</Note>
          </div>
        )}
        {connection && (
          <p role="status" className="text-ok text-sm">
            {connection}
          </p>
        )}
        {saved && (
          <p role="status" className="text-muted-foreground text-sm">
            Settings saved.
          </p>
        )}
      </form>
    </SettingsGroup>
  );
};

const GeneralSection = () => {
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
    <SettingsGroup
      id="roots"
      title="Projects"
      hint="Folders opendevhub scans for projects"
    >
      <div className="flex max-w-2xl flex-col gap-3">
        {roots.length > 0 ? (
          <ul className="flex flex-col divide-y rounded-md border">
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
          </ul>
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
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={scanning || busy}
            onClick={rescan}
          >
            <RefreshCwIcon className={scanning ? "animate-spin" : undefined} />{" "}
            {scanning ? "Scanning…" : "Rescan"}
          </Button>
          <Button asChild variant="ghost">
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              <BookOpenIcon /> Documentation
            </a>
          </Button>
        </div>
      </div>
    </SettingsGroup>
  );
};
