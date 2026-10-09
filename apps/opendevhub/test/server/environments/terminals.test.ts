import { EventEmitter } from "node:events";

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock(import("node-pty"), () => ({ spawn: fake.spawn }));
import { terminalCommand } from "../../../src/server/environments/terminals";
import { startServer } from "../../../src/server/server";

let server: Awaited<ReturnType<typeof startServer>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.clearAllMocks();
});

function connect(origin?: string) {
  return new WebSocket(
    `ws://localhost:${server!.port}/api/terminal?project=p&directory=%2Fworkspaces%2Fbranch&shell=zsh`,
    { origin }
  );
}

describe("terminal routing", () => {
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
