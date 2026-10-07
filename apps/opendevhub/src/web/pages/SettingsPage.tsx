import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Note, Page, PageHeader, Section } from "../components/Page";
import type { IntegrationSettings, IntegrationSettingsInput } from "../../shared/integrations";
import { useDash } from "../DashboardContext";
import { testForgejoConnection } from "../api";

export function SettingsPage() {
  const { forgejo, forgejoError, updateForgejo, jira, jiraError, updateJira } = useDash();
  return <Page>
    <PageHeader title="Settings" description="Optional integrations for your dashboard." />
    <IntegrationSettingsForm name="Forgejo" hint="Your pull requests and their diffs" settings={forgejo} settingsError={forgejoError} update={updateForgejo}
      tokenHelp="Use a token with read:user, read:repository, and read:issue scopes, including private repositories you want to see." />
    <IntegrationSettingsForm name="Jira" hint="Assigned tickets and tasks" settings={jira} settingsError={jiraError} update={updateJira}
      tokenHelp="Use a personal access token from your self-hosted Jira Server or Data Center profile, with permission to browse the projects you need." />
  </Page>;
}

function IntegrationSettingsForm({ name, hint, settings, settingsError, update, tokenHelp }: {
  name: "Forgejo" | "Jira"; hint: string; settings?: IntegrationSettings; settingsError?: string;
  update: (input: IntegrationSettingsInput) => Promise<void>; tokenHelp: string;
}) {
  const id = name.toLowerCase();
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [connection, setConnection] = useState<string>();
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true); setError(undefined); setConnection(undefined);
    try {
      const result = await testForgejoConnection({ url, ...(token.trim() ? { token: token.trim() } : {}) });
      setConnection(`Connected as ${result.username} · API ${result.version}. Read access verified.`);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setTesting(false); }
  };
  useEffect(() => { setConnection(undefined); }, [url, token]);

  useEffect(() => {
    if (!settings) return;
    setEnabled(settings.enabled);
    setUrl(settings.url);
    setToken("");
  }, [settings]);

  const save = async (e?: FormEvent, removeToken = false) => {
    e?.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await update({
        enabled: removeToken ? false : enabled, url,
        ...(removeToken ? { clearToken: true } : token.trim() ? { token: token.trim() } : {}),
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
    <Section title={name} hint={hint}>
      <form className="flex max-w-2xl flex-col gap-5 px-4 py-4" onSubmit={(e) => void save(e)}>
        <fieldset disabled={busy || testing || loading} className="flex flex-col gap-5 disabled:opacity-60">
          <div className="flex items-center gap-3">
            <Switch id={`${id}-enabled`} checked={enabled} onCheckedChange={(value) => { setEnabled(value); setSaved(false); }} />
            <Label htmlFor={`${id}-enabled`}>Enable {name}</Label>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-url`}>{name} URL</Label>
            <Input id={`${id}-url`} type="url" placeholder={`https://${id}.example.com`} value={url} onChange={(e) => { setUrl(e.target.value); setSaved(false); }} autoComplete="off" spellCheck={false} />
            <p className="text-sm text-muted-foreground">The instance URL, including its path prefix if needed. Use HTTPS; local instances may use loopback HTTP.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-token`}>Access token</Label>
            <Input id={`${id}-token`} type="password" value={token} onChange={(e) => { setToken(e.target.value); setSaved(false); }} placeholder={settings?.hasToken ? "Token saved — leave blank to keep it" : `Paste a ${name} access token`} autoComplete="new-password" spellCheck={false} />
            <p className="text-sm text-muted-foreground">{tokenHelp} Changing the URL requires a new token.</p>
            <p className="text-sm text-muted-foreground">Saved in your operating system's credential store. The token is never written to the settings file or returned to the browser.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {name === "Forgejo" && <Button type="button" variant="outline" disabled={!url.trim()} onClick={() => void test()}>{testing ? "Testing…" : "Test connection"}</Button>}
            <Button type="submit">{busy ? "Saving…" : "Save settings"}</Button>
            {settings?.hasToken && <Button type="button" variant="outline" onClick={() => void save(undefined, true)}>Remove token and disable</Button>}
          </div>
        </fieldset>
        {loading && <p role="status" className="text-sm text-muted-foreground">Loading settings…</p>}
        {(error || settingsError) && <div role="alert"><Note warn>{error || settingsError}</Note></div>}
        {connection && <p role="status" className="text-sm text-ok">{connection}</p>}
        {saved && <p role="status" className="text-sm text-muted-foreground">Settings saved.</p>}
      </form>
    </Section>
  );
}
