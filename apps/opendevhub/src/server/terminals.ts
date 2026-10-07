import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { spawn, type IPty } from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { clientArgs, remoteCommand, type SshTarget } from "./ssh";

export interface TerminalTarget {
  containerId: string;
  user?: string;
  ssh?: SshTarget;
}

export function terminalCommand(target: TerminalTarget, directory: string, shell: string) {
  if (!["bash", "zsh", "sh", "fish"].includes(shell)) throw new Error("Unsupported shell");
  const args = ["exec", "-it", "-e", "TERM=xterm-256color", "-w", directory];
  if (target.user) args.push("-u", target.user);
  args.push(target.containerId, shell, "-i");
  return target.ssh
    ? { file: "ssh", args: [...clientArgs(target.ssh), "-tt", target.ssh.dest, remoteCommand("docker", args)] }
    : { file: "docker", args };
}

interface Session {
  pty: IPty;
  clients: Set<WebSocket>;
  output: string;
  timer?: ReturnType<typeof setTimeout>;
}

/** One persistent shell per checkout and shell choice, with bounded replay on reconnect. */
export class Terminals {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly target: (project: string, directory: string) => TerminalTarget) {}

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    // Browsers must originate on the dashboard; reject cross-site shell access.
    let sameOrigin = false;
    try { sameOrigin = !!req.headers.origin && new URL(req.headers.origin).host === req.headers.host; } catch { /* Reject malformed origins. */ }
    if (!sameOrigin) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const url = new URL(req.url!, "http://localhost");
    const project = url.searchParams.get("project") ?? "";
    const directory = url.searchParams.get("directory") ?? "";
    const shell = url.searchParams.get("shell") ?? "bash";
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const send = (value: unknown) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
      };
      try {
        const target = this.target(project, directory);
        const command = terminalCommand(target, directory, shell);
        const key = JSON.stringify([project, directory, shell, target]);
        let session = this.sessions.get(key);
        if (!session) {
          if (this.sessions.size >= 64) throw new Error("Too many terminal sessions; exit an unused shell first");
          const pty = spawn(command.file, command.args, {
            name: "xterm-256color", cols: 80, rows: 24,
            env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          });
          session = { pty, clients: new Set(), output: "" };
          this.sessions.set(key, session);
          const current = session;
          pty.onData((data) => {
            current.output = (current.output + data).slice(-100_000);
            for (const client of current.clients) {
              if (client.readyState !== WebSocket.OPEN) continue;
              if (client.bufferedAmount > 1024 * 1024) client.close(1013, "Terminal client is too slow");
              else client.send(JSON.stringify({ type: "output", data }));
            }
          });
          pty.onExit(({ exitCode }) => {
            clearTimeout(current.timer);
            this.sessions.delete(key);
            for (const client of current.clients) {
              if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ type: "exit", exitCode }));
              client.close();
            }
          });
        }
        clearTimeout(session.timer);
        session.clients.add(ws);
        send({ type: "output", data: session.output });
        send({ type: "ready" });
        const current = session;
        ws.on("message", (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === "input" && typeof msg.data === "string") current.pty.write(msg.data);
            else if (msg.type === "resize" && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)
              && msg.cols > 0 && msg.cols <= 500 && msg.rows > 0 && msg.rows <= 200) current.pty.resize(msg.cols, msg.rows);
          } catch { ws.close(1008, "Invalid terminal message"); }
        });
        ws.on("error", () => {});
        ws.on("close", () => {
          current.clients.delete(ws);
          if (current.clients.size === 0 && this.sessions.get(key) === current) current.timer = setTimeout(() => {
            this.sessions.delete(key);
            current.pty.kill();
          }, 30 * 60_000).unref();
        });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : "Unable to open terminal" });
        ws.close();
      }
    });
  }

  close() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const session of sessions) {
      clearTimeout(session.timer);
      for (const client of session.clients) client.terminate();
      session.pty.kill();
    }
    this.sessions.clear();
    this.wss.close();
  }
}
