import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import "@xterm/xterm/css/xterm.css";
import { Button } from "@/components/ui/button";

import { checkoutRuntime } from "../checkouts";
import { useCheckout } from "./checkout-page";

export const CheckoutTerminal = () => {
  const { view, checkout } = useCheckout();
  return (
    <TerminalPanel
      key={`${view.project.id}:${checkout.directory}`}
      project={view.project.id}
      directory={checkout.directory}
      running={
        checkoutRuntime(view, checkout.directory).containerState === "running"
      }
    />
  );
};

const TerminalPanel = ({
  project,
  directory,
  running,
}: {
  project: string;
  directory: string;
  running: boolean;
}) => {
  const storageKey = `terminal-shell:${project}:${directory}`;
  const [shell, setShell] = useState(() => {
    try {
      return localStorage.getItem(storageKey) || "bash";
    } catch {
      return "bash";
    }
  });
  const [status, setStatus] = useState("Connecting…");
  const [retry, setRetry] = useState(0);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!running || !container.current) {
      return;
    }
    setStatus("Connecting…");
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    fit.fit();
    const params = new URLSearchParams({ directory, project, shell });
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/terminal?${params}`
    );
    let ended = false;
    const send = (msg: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    };
    const resize = () => {
      fit.fit();
      send({ cols: terminal.cols, rows: terminal.rows, type: "resize" });
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    const input = terminal.onData((data) => send({ data, type: "input" }));
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "output") {
        terminal.write(msg.data);
      }
      if (msg.type === "ready") {
        setStatus("Connected");
        resize();
        terminal.focus();
      }
      if (msg.type === "error") {
        ended = true;
        setStatus(msg.message);
      }
      if (msg.type === "exit") {
        ended = true;
        setStatus(`Shell exited (${msg.exitCode})`);
      }
    };
    ws.onerror = () => setStatus("Unable to connect to terminal");
    ws.onclose = () => {
      if (!ended) {
        setStatus("Disconnected");
      }
    };
    return () => {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      observer.disconnect();
      input.dispose();
      ws.close();
      terminal.dispose();
    };
  }, [project, directory, shell, running, retry]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          Shell
          <select
            aria-label="Terminal shell"
            className="bg-background rounded-md border px-3 py-2"
            value={shell}
            onChange={(event) => {
              setShell(event.target.value);
              try {
                localStorage.setItem(storageKey, event.target.value);
              } catch {
                /* Storage may be disabled. */
              }
            }}
          >
            {["bash", "zsh", "sh", "fish"].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
        <span role="status" className="text-muted-foreground text-sm">
          {running
            ? status
            : "Start this checkout's container to open a terminal."}
        </span>
        {running && status !== "Connected" && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRetry((n) => n + 1)}
          >
            Reconnect
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-sm">
        Runs in this checkout&apos;s container. The selected shell must be
        installed there. Sessions stay available for 30 minutes after leaving
        this tab.
      </p>
      {running && (
        <div
          ref={container}
          aria-label="Worktree terminal"
          className="h-[min(65vh,700px)] min-h-72 overflow-hidden rounded-lg bg-black p-3"
        />
      )}
    </section>
  );
};
