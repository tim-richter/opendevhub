import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { checkAccess } from "../api";
import { CopyButton } from "../components/copy-button";
import { muted } from "../components/page";
import { Logo } from "./logo";

const OPEN_COMMAND = "opendevhub open";

/** Shown instead of the dashboard to a browser without the access cookie. */
export const AccessPage = () => (
  <main className="bg-background text-foreground flex min-h-svh items-center justify-center px-4">
    <div className="bg-card flex w-full max-w-md flex-col gap-4 rounded-xl border p-6">
      <Logo size={28} />
      <h1 className="text-lg font-semibold">
        Open the dashboard with its link
      </h1>
      <p className={muted}>
        This browser has no access to opendevhub yet. Run this in a terminal on
        this machine; it opens the dashboard with its link:
      </p>
      <div className="bg-muted flex items-center justify-between gap-2 rounded-md px-3 py-2 font-mono text-sm">
        <code>{OPEN_COMMAND}</code>
        <CopyButton text={OPEN_COMMAND} />
      </div>
      <p className={muted}>
        The link opendevhub printed when it started works too. You need it once
        per browser.
      </p>
    </div>
  </main>
);

/** Renders the dashboard only once the server confirms this browser's access. */
export const AccessGate = ({ children }: { children: ReactNode }) => {
  const [allowed, setAllowed] = useState<boolean>();
  useEffect(() => {
    let live = true;
    void checkAccess().then((ok) => {
      if (live) {
        setAllowed(ok);
      }
    });
    return () => {
      live = false;
    };
  }, []);
  if (allowed === undefined) {
    return null;
  }
  return allowed ? children : <AccessPage />;
};
