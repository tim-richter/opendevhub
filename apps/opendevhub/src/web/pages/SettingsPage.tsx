import { type FormEvent, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Note, Page, PageHeader, Section } from "../components/Page";
import { useDash } from "../DashboardContext";
import { testForgejoConnection } from "../api";

export function SettingsPage() {
  const { forgejo, forgejoError, updateForgejo } = useDash();
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
    if (!forgejo) return;
    setEnabled(forgejo.enabled);
    setUrl(forgejo.url);
    setToken("");
  }, [forgejo]);

  const save = async (e?: FormEvent, removeToken = false) => {
    e?.preventDefault();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      await updateForgejo({
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
  const loading = !forgejo && !forgejoError;

  return (
    <Page>
      <PageHeader title="Settings" description="Optional integrations for your dashboard." />
      <Section title="Forgejo" hint="Your pull requests and their diffs">
        <form className="flex max-w-2xl flex-col gap-5 px-4 py-4" onSubmit={(e) => void save(e)}>
          <fieldset disabled={busy || testing || loading} className="flex flex-col gap-5 disabled:opacity-60">
            <div className="flex items-center gap-3">
              <Switch id="forgejo-enabled" checked={enabled} onCheckedChange={(value) => { setEnabled(value); setSaved(false); }} />
              <Label htmlFor="forgejo-enabled">Enable Forgejo</Label>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="forgejo-url">Forgejo URL</Label>
              <Input id="forgejo-url" type="url" placeholder="https://forgejo.example.com" value={url} onChange={(e) => { setUrl(e.target.value); setSaved(false); }} autoComplete="off" spellCheck={false} />
              <p className="text-sm text-muted-foreground">The instance URL, including its path prefix if needed. Use HTTPS; local instances may use loopback HTTP.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="forgejo-token">Access token</Label>
              <Input id="forgejo-token" type="password" value={token} onChange={(e) => { setToken(e.target.value); setSaved(false); }} placeholder={forgejo?.hasToken ? "Token saved — leave blank to keep it" : "Paste a Forgejo access token"} autoComplete="new-password" spellCheck={false} />
              <p className="text-sm text-muted-foreground">Use a token with read:user, read:repository, and read:issue scopes, including private repositories you want to see. Changing the URL requires a new token.</p>
              <p className="text-sm text-muted-foreground">Saved in your operating system's credential store. The token is never written to the settings file or returned to the browser.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={!url.trim()} onClick={() => void test()}>{testing ? "Testing…" : "Test connection"}</Button>
              <Button type="submit">{busy ? "Saving…" : "Save settings"}</Button>
              {forgejo?.hasToken && <Button type="button" variant="outline" onClick={() => void save(undefined, true)}>Remove token and disable</Button>}
            </div>
          </fieldset>
          {loading && <p role="status" className="text-sm text-muted-foreground">Loading settings…</p>}
          {(error || forgejoError) && <div role="alert"><Note warn>{error || forgejoError}</Note></div>}
          {connection && <p role="status" className="text-sm text-ok">{connection}</p>}
          {saved && <p role="status" className="text-sm text-muted-foreground">Settings saved.</p>}
        </form>
      </Section>
    </Page>
  );
}
