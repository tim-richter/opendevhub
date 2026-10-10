import {
  ChevronRightIcon,
  CircleCheckIcon,
  GitPullRequestIcon,
  TicketIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import { confirm } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

import type {
  IntegrationSettings,
  IntegrationSettingsInput,
} from "../../../shared/integrations";
import { testForgejoConnection } from "../../api";
import { Note } from "../../components/page";
import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";
import {
  SettingRow,
  SettingsBlock,
  SettingsHeader,
  SettingsList,
} from "./settings-layout";
import { SettingsLink } from "./settings-link";

/** Set up enough to deserve its own settings page: a token saved or the integration turned on. */
export const integrationConfigured = (
  settings?: IntegrationSettings
): boolean => !!settings && (settings.enabled || settings.hasToken);

const INTEGRATIONS = {
  forgejo: {
    description: "Your pull requests, their diffs and reviews.",
    icon: GitPullRequestIcon,
    name: "Forgejo",
    tokenHelp:
      "Use a token with read:user, read:repository, and read:issue scopes, including private repositories you want to see.",
  },
  jira: {
    description: "Tickets assigned to you, to start tasks from.",
    icon: TicketIcon,
    name: "Jira",
    tokenHelp:
      "Use a personal access token from your self-hosted Jira Server or Data Center profile, with permission to browse the projects you need.",
  },
} as const;

type IntegrationId = keyof typeof INTEGRATIONS;

const statusOf = (settings?: IntegrationSettings, error?: string) => {
  if (error) {
    return { label: "Error", tone: "text-destructive" };
  }
  if (!settings) {
    return { label: "Loading…", tone: "text-muted-foreground" };
  }
  if (settings.enabled && settings.hasToken) {
    return { label: "Connected", tone: "text-ok" };
  }
  if (settings.hasToken) {
    return { label: "Turned off", tone: "text-muted-foreground" };
  }
  return { label: "Not set up", tone: "text-muted-foreground" };
};

const useIntegration = (id: IntegrationId) => {
  const dash = useDash();
  return id === "forgejo"
    ? {
        error: dash.forgejoError,
        settings: dash.forgejo,
        update: dash.updateForgejo,
      }
    : { error: dash.jiraError, settings: dash.jira, update: dash.updateJira };
};

const IntegrationRow = ({ id }: { id: IntegrationId }) => {
  const meta = INTEGRATIONS[id];
  const { settings, error } = useIntegration(id);
  const status = statusOf(settings, error);
  const Icon = meta.icon;
  return (
    <li>
      <SettingsLink
        section={id}
        replace
        className="hover:bg-muted/50 flex items-center gap-3 px-4 py-3 transition-colors first:rounded-t-lg last:rounded-b-lg"
      >
        <span className="bg-muted grid size-9 shrink-0 place-content-center rounded-md">
          <Icon className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="font-medium">{meta.name}</span>
          <span className="text-muted-foreground truncate text-sm">
            {settings?.url || meta.description}
          </span>
        </span>
        <span className={cn("text-sm whitespace-nowrap", status.tone)}>
          {status.label}
        </span>
        <ChevronRightIcon className="text-muted-foreground size-4" />
      </SettingsLink>
    </li>
  );
};

export const IntegrationsSettings = () => (
  <>
    <SettingsHeader
      title="Integrations"
      description="Connect the services opendevhub reads pull requests and tickets from. Each one gets its own page in this sidebar once it's set up."
    />
    <SettingsBlock title="Services">
      <SettingsList>
        <IntegrationRow id="forgejo" />
        <IntegrationRow id="jira" />
      </SettingsList>
    </SettingsBlock>
  </>
);

export const IntegrationSettingsPage = ({ id }: { id: IntegrationId }) => {
  const meta = INTEGRATIONS[id];
  const { settings, error, update } = useIntegration(id);
  return (
    <>
      <SettingsHeader title={meta.name} description={meta.description} />
      <IntegrationSettingsForm
        id={id}
        name={meta.name}
        settings={settings}
        settingsError={error}
        update={update}
        tokenHelp={meta.tokenHelp}
      />
      {settings?.enabled && (
        <SettingsBlock title="Open" hint={`See what ${meta.name} has for you.`}>
          <div>
            <Button asChild variant="outline">
              <Link to={`/${id}`}>
                {id === "forgejo" ? "Pull requests" : "Tickets"}
                <ChevronRightIcon />
              </Link>
            </Button>
          </div>
        </SettingsBlock>
      )}
    </>
  );
};

const IntegrationSettingsForm = ({
  id,
  name,
  settings,
  settingsError,
  update,
  tokenHelp,
}: {
  id: IntegrationId;
  name: string;
  settings?: IntegrationSettings;
  settingsError?: string;
  update: (input: IntegrationSettingsInput) => Promise<void>;
  tokenHelp: string;
}) => {
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
    <SettingsBlock
      title="Connection"
      hint="Where the instance is and how opendevhub signs in."
    >
      <form className="flex flex-col gap-5" onSubmit={(e) => void save(e)}>
        <fieldset
          disabled={busy || testing || loading}
          className="flex flex-col gap-5 disabled:opacity-60"
        >
          <SettingRow
            label={`Enable ${name}`}
            description="Show it in the sidebar and offer its items when starting tasks."
            htmlFor={`${id}-enabled`}
          >
            <Switch
              id={`${id}-enabled`}
              checked={enabled}
              onCheckedChange={(value) => {
                setEnabled(value);
                setSaved(false);
              }}
            />
          </SettingRow>
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
            {id === "forgejo" && (
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
    </SettingsBlock>
  );
};
