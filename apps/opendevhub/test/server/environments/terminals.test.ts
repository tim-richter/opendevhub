import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock(import("node-pty"), () => ({ spawn: fake.spawn }));
import {
  execCommand,
  inDirectory,
  shellCommand,
  terminalCommand,
} from "../../../src/server/environments/terminals";
import { startServer } from "../../../src/server/server";
import { testAccess } from "../../helpers/access";

let server: Awaited<ReturnType<typeof startServer>> | undefined;
const { access, cookie } = testAccess();
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.clearAllMocks();
});

function connect(origin?: string, terminal?: string, withCookie = true) {
  const params = new URLSearchParams({
    project: "p",
    directory: "/workspaces/branch",
    shell: "zsh",
  });
  if (terminal !== undefined) {
    params.set("terminal", terminal);
  }
  return new WebSocket(
    `ws://localhost:${server!.port}/api/terminal?${params}`,
    { origin, headers: withCookie ? { cookie } : {} }
  );
}

describe("terminal routing", () => {
  it("kills a deleted terminal session and starts a fresh shell on reconnect", async () => {
    const createPty = () => ({
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    });
    const firstPty = createPty();
    const secondPty = createPty();
    fake.spawn.mockReturnValueOnce(firstPty).mockReturnValueOnce(secondPty);
    server = await startServer({
      port: 0,
      access,
      app: new Hono(),
      resolveTarget: () => {},
      terminalTarget: () => ({ containerId: "c" }),
    });
    const attach = async () => {
      const ws = connect(`http://localhost:${server!.port}`, "deleted");
      await new Promise<void>((resolve, reject) => {
        ws.on("error", reject);
        ws.on("message", (raw) => {
          if (JSON.parse(raw.toString()).type === "ready") {
            resolve();
          }
        });
      });
      return ws;
    };
    const first = await attach();
    first.send(JSON.stringify({ type: "close" }));
    await new Promise<void>((resolve) => first.on("close", resolve));
    expect(firstPty.kill).toHaveBeenCalledOnce();

    const second = await attach();
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    second.terminate();
  });

  it("isolates terminals with the same shell and reconnects to their own sessions", async () => {
    const createPty = () => {
      const events = new EventEmitter();
      return {
        events,
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(),
        onData: (fn: (data: string) => void) => events.on("data", fn),
        onExit: (fn: () => void) => events.on("exit", fn),
      };
    };
    const firstPty = createPty();
    const secondPty = createPty();
    fake.spawn.mockReturnValueOnce(firstPty).mockReturnValueOnce(secondPty);
    server = await startServer({
      port: 0,
      access,
      app: new Hono(),
      resolveTarget: () => {},
      terminalTarget: () => ({ containerId: "c" }),
    });
    const attach = async (terminal: string) => {
      const ws = connect(`http://localhost:${server!.port}`, terminal);
      const messages: { type: string; data?: string }[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.on("error", reject);
        ws.on("message", (raw) => {
          const message = JSON.parse(raw.toString());
          messages.push(message);
          if (message.type === "ready") {
            resolve();
          }
        });
      });
      return { ws, messages };
    };
    const first = await attach("first");
    const second = await attach("second");
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    first.ws.send(JSON.stringify({ type: "input", data: "first command\r" }));
    second.ws.send(JSON.stringify({ type: "input", data: "second command\r" }));
    await vi.waitFor(() => {
      expect(firstPty.write).toHaveBeenCalledExactlyOnceWith("first command\r");
      expect(secondPty.write).toHaveBeenCalledExactlyOnceWith(
        "second command\r"
      );
    });
    firstPty.events.emit("data", "first output");
    secondPty.events.emit("data", "second output");
    first.ws.close();
    await new Promise<void>((resolve) => first.ws.on("close", resolve));
    const reconnected = await attach("first");
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    expect(reconnected.messages).toContainEqual({
      type: "output",
      data: "first output",
    });
    expect(reconnected.messages).not.toContainEqual({
      type: "output",
      data: "second output",
    });
    await vi.waitFor(() =>
      expect(second.messages).toContainEqual({
        type: "output",
        data: "second output",
      })
    );
    expect(second.messages).not.toContainEqual({
      type: "output",
      data: "first output",
    });
    await server.close();
    server = undefined;
    expect(firstPty.kill).toHaveBeenCalledOnce();
    expect(secondPty.kill).toHaveBeenCalledOnce();
    second.ws.terminate();
    reconnected.ws.terminate();
  });

  it("uses a container PTY, checkout directory and configured user", () => {
    expect(
      terminalCommand(
        { containerId: "container", user: "dev" },
        "/branch",
        "zsh"
      )
    ).toStrictEqual({
      file: "docker",
      args: [
        "exec",
        "-it",
        "-e",
        "TERM=xterm-256color",
        "-w",
        "/branch",
        "-u",
        "dev",
        "container",
        "zsh",
        "-i",
      ],
    });
    expect(() =>
      terminalCommand(
        { containerId: "c" },
        "/branch",
        "bash; touch /tmp/injected"
      )
    ).toThrow("Unsupported shell");
  });

  it("quotes remote commands and uses the existing SSH connection", () => {
    const command = terminalCommand(
      { containerId: "c", ssh: { dest: "node", control: "/socket" } },
      "/branch with 'quotes'",
      "bash"
    );
    expect(command.file).toBe("ssh");
    expect(command.args).toContain("-tt");
    expect(command.args.at(-1)).toContain("'/branch with");
  });

  it.each([undefined, "http://evil.example", "invalid"])(
    "rejects origin %s before resolving or spawning",
    async (origin) => {
      const target = vi.fn(() => ({ containerId: "c" }));
      server = await startServer({
        port: 0,
        access,
        app: new Hono(),
        resolveTarget: () => {},
        terminalTarget: target,
      });
      const ws = connect(origin);
      ws.on("error", () => {});
      const status = await new Promise<number>((resolve) =>
        ws.on("unexpected-response", (_req, res) => {
          res.resume();
          ws.terminate();
          resolve(res.statusCode!);
        })
      );
      expect(status).toBe(403);
      expect(target).not.toHaveBeenCalled();
      expect(fake.spawn).not.toHaveBeenCalled();
    }
  );

  it("rejects a socket without the dashboard cookie before resolving", async () => {
    const target = vi.fn(() => ({ containerId: "c" }));
    server = await startServer({
      port: 0,
      access,
      app: new Hono(),
      resolveTarget: () => {},
      terminalTarget: target,
    });
    const ws = connect(`http://localhost:${server.port}`, undefined, false);
    ws.on("error", () => {});
    const status = await new Promise<number>((resolve) =>
      ws.on("unexpected-response", (_req, res) => {
        res.resume();
        ws.terminate();
        resolve(res.statusCode!);
      })
    );
    expect(status).toBe(401);
    expect(target).not.toHaveBeenCalled();
  });

  it("routes input and resize, replays output on reconnect and kills on shutdown", async () => {
    const events = new EventEmitter();
    const pty = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: (fn: (data: string) => void) => events.on("data", fn),
      onExit: (fn: () => void) => events.on("exit", fn),
    };
    fake.spawn.mockReturnValue(pty);
    const target = vi.fn(() => ({
      containerId: "worktree-container",
      user: "dev",
    }));
    server = await startServer({
      port: 0,
      access,
      app: new Hono(),
      resolveTarget: () => {},
      terminalTarget: target,
    });
    const attach = async () => {
      const ws = connect(`http://localhost:${server!.port}`);
      const messages: { type: string; data?: string }[] = [];
      await new Promise<void>((resolve, reject) => {
        ws.on("error", reject);
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          messages.push(msg);
          if (msg.type === "ready") {
            resolve();
          }
        });
      });
      return { ws, messages };
    };
    const first = await attach();
    expect(target).toHaveBeenCalledWith("p", "/workspaces/branch");
    first.ws.send(JSON.stringify({ type: "input", data: "pwd\r" }));
    first.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await vi.waitFor(() => expect(pty.resize).toHaveBeenCalledWith(120, 40));
    expect(pty.write).toHaveBeenCalledWith("pwd\r");
    events.emit("data", "hello\r\n");
    await vi.waitFor(() =>
      expect(first.messages).toContainEqual({
        type: "output",
        data: "hello\r\n",
      })
    );
    first.ws.close();
    await new Promise<void>((resolve) => first.ws.on("close", resolve));
    const second = await attach();
    expect(fake.spawn).toHaveBeenCalledOnce();
    expect(second.messages).toContainEqual({
      type: "output",
      data: "hello\r\n",
    });
    await server.close();
    server = undefined;
    expect(pty.kill).toHaveBeenCalledOnce();
    second.ws.terminate();
  });
});

describe("CLI exec commands", () => {
  const target = { containerId: "c", env: { A: "1" }, user: "dev" };

  it("runs a command locally with or without a TTY", () => {
    expect(
      execCommand(target, "/w", ["jq", "."], { tty: false, term: "xterm" })
    ).toStrictEqual({
      args: [
        "exec",
        "-i",
        "-w",
        "/w",
        "-e",
        "A=1",
        "-u",
        "dev",
        "c",
        "jq",
        ".",
      ],
      file: "docker",
    });
    expect(
      execCommand(target, "/w", ["zsh", "-i"], {
        tty: true,
        term: "tmux-256color",
      }).args
    ).toStrictEqual([
      "exec",
      "-it",
      "-e",
      "TERM=tmux-256color",
      "-w",
      "/w",
      "-e",
      "A=1",
      "-u",
      "dev",
      "c",
      "zsh",
      "-i",
    ]);
  });

  it("wraps the command in ssh for a remote node, with a TTY only when asked", () => {
    const ssh = { control: "/socket", dest: "tim@box" };
    const piped = execCommand(
      { ...target, ssh },
      "/w",
      ["sh", "-c", "exit 3"],
      {
        tty: false,
      }
    );
    expect(piped.file).toBe("ssh");
    expect(piped.args).toContain("-T");
    expect(piped.args).not.toContain("-tt");
    expect(piped.args.at(-1)).toBe(
      "docker exec -i -w /w -e A=1 -u dev c sh -c 'exit 3'"
    );
    const attached = execCommand({ ...target, ssh }, "/w", ["bash", "-i"], {
      tty: true,
    });
    expect(attached.args).toContain("-tt");
    expect(attached.args.slice(0, 4)).toStrictEqual([
      "-S",
      "/socket",
      "-o",
      "BatchMode=yes",
    ]);
  });

  it("uses --shell as given and refuses others", () => {
    expect(shellCommand("fish", "/bin/zsh")).toStrictEqual(["fish", "-i"]);
    expect(() => shellCommand("python", undefined)).toThrow(
      /Unsupported shell/u
    );
  });

  it("prefers the host shell by name, falling back to bash for unknown ones", () => {
    expect(shellCommand(undefined, "/usr/bin/zsh").at(-1)).toBe("zsh");
    expect(shellCommand(undefined, "/opt/bin/nu").at(-1)).toBe("bash");
    expect(shellCommand(undefined, undefined).at(-1)).toBe("bash");
  });

  it("falls back from a missing shell to bash, then sh", () => {
    const [file, ...args] = shellCommand(undefined, undefined);
    const run = (first: string) =>
      spawnSync(file, [...args.slice(0, -1), first], {
        encoding: "utf8",
        input: 'echo "shell=$0"\n',
      }).stdout;
    expect(run("no-such-shell")).toMatch(/shell=bash/u);
  });

  it("starts in the folder when it exists, and in the working directory otherwise", () => {
    const pwd = (dir: string) => {
      const [file, ...args] = inDirectory(dir, ["pwd"]);
      return spawnSync(file, args, {
        cwd: "/",
        encoding: "utf8",
      }).stdout.trim();
    };
    expect(pwd("/tmp")).toBe("/tmp");
    expect(pwd("/no/such/folder")).toBe("/");
  });
});
