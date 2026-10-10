import { SendIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

import { Note } from "../../components/page";
import { useDash } from "../../dashboard-context";
import { disablePush, pushEnabled, sendTestNotification } from "../../push";
import { SettingRow, SettingsBlock, SettingsHeader } from "./settings-layout";

const PermissionNote = ({ permission }: { permission: string }) => {
  if (permission === "unsupported") {
    return (
      <Note warn>
        This browser can&apos;t receive push notifications here. They need a
        secure page (localhost or HTTPS) and a browser with service workers.
      </Note>
    );
  }
  if (permission === "denied") {
    return (
      <Note warn>
        Notifications are blocked for this site. Allow them in your
        browser&apos;s site settings, then reload the page.
      </Note>
    );
  }
  return null;
};

export const NotificationSettings = () => {
  const { permission, requestPermission } = useDash();
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();

  useEffect(() => {
    let live = true;
    pushEnabled().then(
      (value) => live && setEnabled(value),
      () => live && setEnabled(false)
    );
    return () => {
      live = false;
    };
  }, [permission]);

  const toggle = async (on: boolean) => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      if (on) {
        await requestPermission();
      } else {
        await disablePush();
      }
      setEnabled(await pushEnabled());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const sent = await sendTestNotification();
      setResult(
        sent === 0
          ? "No browser is subscribed to notifications."
          : `Sent to ${sent} ${sent === 1 ? "browser" : "browsers"}.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const blocked = permission === "unsupported" || permission === "denied";

  return (
    <>
      <SettingsHeader
        title="Notifications"
        description="Hear about sessions that need you, even with no opendevhub tab open."
      />
      <SettingsBlock
        title="Browser notifications"
        hint="opendevhub notifies you when an agent asks for permission, asks a question, or finishes. Each browser opts in on its own."
      >
        <SettingRow
          label="Enable notifications"
          description="Subscribes this browser to opendevhub's push notifications."
          htmlFor="notifications-enabled"
        >
          <Switch
            id="notifications-enabled"
            checked={enabled ?? false}
            disabled={busy || blocked || enabled === undefined}
            onCheckedChange={(on) => void toggle(on)}
          />
        </SettingRow>
        <PermissionNote permission={permission} />
      </SettingsBlock>
      <SettingsBlock
        title="Test"
        hint="Sends a notification to every subscribed browser, so you can check they arrive."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={busy || !enabled}
            onClick={() => void test()}
          >
            <SendIcon /> Send test notification
          </Button>
          {result && (
            <p role="status" className="text-muted-foreground text-sm">
              {result}
            </p>
          )}
        </div>
        {error && (
          <div role="alert">
            <Note error>{error}</Note>
          </div>
        )}
      </SettingsBlock>
    </>
  );
};
