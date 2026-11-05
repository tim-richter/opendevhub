import { describe, expect, it, vi } from "vitest";

import type { CliTarget } from "../../src/server/environments/environments";
import {
  LocalApi,
  parseTerminalArgs,
  runTerminalCommand,
} from "../../src/server/terminal-cli";
import type { TerminalIo } from "../../src/server/terminal-cli";

const stopped: CliTarget = {
  branch: "main",
  busy: false,
  envId: "demo-abc123",
  main: true,
  node: "local",
  projectId: "demo-abc123",
  projectName: "demo",
  state: "stopped",
};
const running: CliTarget = {
  ...stopped,
  exec: {
    containerId: "c1",
    directory: "/workspaces/demo/ui",
    env: { A: "1" },
    root: "/workspaces/demo",
    user: "node",
  },
  state: "running",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

/** A fake server: `routes` answers `METHOD /path` (without the query), in order for repeated calls. */
function harness(
  routes: Record<string, (Response | (() => Response))[]>,
  io: Partial<TerminalIo> = {}
) {
  const calls: string[] = [];
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      const key = `${init?.method ?? "GET"} ${u.pathname}`;
      calls.push(`${key}${u.search}`);
      const queue = routes[key];
      if (!queue || queue.length === 0) {
        throw new Error(`unexpected ${key}`);
      }
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      return typeof next === "function" ? next() : next.clone();
    }
  );
  const out: string[] = [];
  const err: string[] = [];
  const run = vi.fn(async (_file: string, _args: string[]) => 0);
  const exec = (command: string, argv: string[] = []) =>
    runTerminalCommand(
      command as "ls",
      argv,
      {
        cwd: "/src/demo/ui",
        env: { SHELL: "/bin/zsh", TERM: "tmux-256color" },
        error: (s) => err.push(s),
        log: (s) => out.push(s),
        stdinIsTty: true,
        stdoutIsTty: true,
        ...io,
      },
      {
        api: new LocalApi(7777, "cookie", fetcher as typeof fetch),
        dashboardUrl: () => "http://localhost:7777/?token=t",
        run,
        sleep: async () => {},
      }
    );
  return { calls, err, exec, fetcher, out, run };
}

describe(parseTerminalArgs, () => {
  it("parses targets, --shell and the command after --", () => {
    expect(parseTerminalArgs("attach", ["feat", "--shell", "fish"])).toEqual({
      command: "attach",
      shell: "fish",
      target: "feat",
    });
    expect(parseTerminalArgs("up", [])).toEqual({ command: "up" });
    expect(parseTerminalArgs("exec", ["--", "sh", "-c", "exit 3"])).toEqual({
      command: "exec",
      run: ["sh", "-c", "exit 3"],
    });
    expect(parseTerminalArgs("exec", ["feat", "--", "ls", "--", "-l"])).toEqual(
      { command: "exec", run: ["ls", "--", "-l"], target: "feat" }
    );
  });

  it.each([
    ["ls", ["x"]],
    ["up", ["a", "b"]],
    ["up", ["--shell", "zsh"]],
    ["attach", ["--", "ls"]],
    ["exec", ["ls"]],
    ["exec", ["--"]],
  ] as const)("refuses %s %j with its usage", (command, argv) => {
    expect(() => parseTerminalArgs(command, [...argv])).toThrow(
      `usage: opendevhub ${command}`
    );
  });
});

describe(runTerminalCommand, () => {
  it("authenticates with the dashboard cookie and sends the folder", async () => {
    const h = harness({ "GET /api/cli/target": [json(running)] });
    expect(await h.exec("exec", ["--", "true"])).toBe(0);
    const [, init] = h.fetcher.mock.calls[0];
    expect(init?.headers).toEqual({ cookie: "odh=cookie" });
    expect(h.calls[0]).toBe("GET /api/cli/target?dir=%2Fsrc%2Fdemo%2Fui");
  });

  it("says how to start opendevhub when it isn't running, and starts nothing", async () => {
    const h = harness({});
    h.fetcher.mockRejectedValue(new TypeError("fetch failed"));
    expect(await h.exec("attach")).toBe(1);
    expect(h.err.join("\n")).toMatch(
      /opendevhub isn't running on port 7777; start it with `opendevhub`/u
    );
    expect(h.run).not.toHaveBeenCalled();
  });

  it("prints the server's error, such as an unregistered folder", async () => {
    const h = harness({
      "GET /api/cli/target": [
        json(
          {
            error:
              "/tmp is not inside a project opendevhub knows; add the project in the dashboard",
          },
          404
        ),
      ],
    });
    expect(await h.exec("up")).toBe(1);
    expect(h.err).toEqual([
      "/tmp is not inside a project opendevhub knows; add the project in the dashboard",
    ]);
  });

  it("lists environments, main first, with branch, id, node and state", async () => {
    const h = harness({
      "GET /api/cli/envs": [
        json({
          envs: [
            { ...stopped, state: "running" },
            {
              branch: "feat/login",
              busy: false,
              envId: "demo-feat",
              main: false,
              node: "box",
              state: "stopped",
            },
          ],
          projectName: "demo",
        }),
      ],
    });
    expect(await h.exec("ls")).toBe(0);
    expect(h.out).toEqual([
      "demo",
      "BRANCH       ENV          NODE   STATE",
      "main (main)  demo-abc123  local  running",
      "feat/login   demo-feat    box    stopped",
    ]);
  });

  it("starts a stopped environment, printing its setup log, then attaches in the matching folder", async () => {
    const h = harness({
      "GET /api/cli/target": [
        json(stopped),
        json({ ...stopped, busy: true, state: "starting" }),
        json(running),
      ],
      "GET /api/projects/demo-abc123/envs/demo-abc123/logs": [
        json({ lines: [{ at: 1, text: "old" }] }),
        json({
          lines: [
            { at: 1, text: "old" },
            { at: 2, text: "up 1/2" },
          ],
        }),
        json({
          lines: [
            { at: 1, text: "old" },
            { at: 2, text: "up 1/2" },
            { at: 3, text: "up 2/2" },
          ],
        }),
      ],
      "POST /api/projects/demo-abc123/start": [json({ accepted: true }, 202)],
    });
    expect(await h.exec("attach")).toBe(0);
    expect(h.err).toEqual(["Starting main (demo-abc123)…", "up 1/2", "up 2/2"]);
    const [file, args] = h.run.mock.calls[0];
    expect(file).toBe("docker");
    expect(args.slice(0, 6)).toEqual([
      "exec",
      "-it",
      "-e",
      "TERM=tmux-256color",
      "-w",
      "/workspaces/demo",
    ]);
    expect(args).toContain("c1");
    expect(args.slice(args.indexOf("c1") + 1)).toEqual([
      "sh",
      "-c",
      expect.stringContaining('cd -- "$1"'),
      "sh",
      "/workspaces/demo/ui",
      "sh",
      "-c",
      expect.stringContaining('for s in "$1" bash sh'),
      "sh",
      "zsh",
    ]);
  });

  it("starts a task environment through its own route", async () => {
    const task = { ...stopped, envId: "demo-feat", main: false };
    const h = harness({
      "GET /api/cli/target": [
        json(task),
        json({ ...running, ...task, state: "running", exec: running.exec }),
      ],
      "GET /api/projects/demo-abc123/envs/demo-feat/logs": [
        json({ lines: [] }),
      ],
      "POST /api/projects/demo-abc123/envs/demo-feat/start": [
        json({ accepted: true }, 202),
      ],
    });
    expect(await h.exec("up", ["feat"])).toBe(0);
    expect(h.calls).toContain(
      "GET /api/cli/target?dir=%2Fsrc%2Fdemo%2Fui&name=feat"
    );
  });

  it("opens the shell straight away when the environment runs", async () => {
    const h = harness({ "GET /api/cli/target": [json(running)] });
    expect(await h.exec("attach", ["--shell", "bash"])).toBe(0);
    expect(h.calls).toEqual(["GET /api/cli/target?dir=%2Fsrc%2Fdemo%2Fui"]);
    expect(h.run.mock.calls[0][1].slice(-2)).toEqual(["bash", "-i"]);
  });

  it("lists the unapproved settings and the dashboard link, and fails", async () => {
    const h = harness({
      "GET /api/cli/target": [json(stopped)],
      "GET /api/projects/demo-abc123/envs/demo-abc123/logs": [
        json({ lines: [] }),
      ],
      "POST /api/projects/demo-abc123/start": [
        json(
          {
            approval: { changes: [{ key: "runArgs", kind: "added" }] },
            error: "its devcontainer config changes host-affecting settings",
          },
          409
        ),
      ],
    });
    expect(await h.exec("attach")).toBe(1);
    expect(h.err.join("\n")).toContain("added\trunArgs");
    expect(h.err.join("\n")).toContain("http://localhost:7777/?token=t");
    expect(h.run).not.toHaveBeenCalled();
  });

  it("fails when the start fails", async () => {
    const h = harness({
      "GET /api/cli/target": [
        json(stopped),
        json({ ...stopped, error: "devcontainer up failed", state: "error" }),
      ],
      "GET /api/projects/demo-abc123/envs/demo-abc123/logs": [
        json({ lines: [] }),
      ],
      "POST /api/projects/demo-abc123/start": [json({ accepted: true }, 202)],
    });
    expect(await h.exec("up")).toBe(1);
    expect(h.err.at(-1)).toBe(
      "main (demo-abc123) didn't start: devcontainer up failed"
    );
  });

  it("refuses an unknown --shell before starting anything", async () => {
    const h = harness({});
    expect(await h.exec("attach", ["--shell", "python"])).toBe(1);
    expect(h.err[0]).toMatch(/Unsupported shell python/u);
    expect(h.fetcher).not.toHaveBeenCalled();
  });

  it("passes exec's exit code through, with a TTY only on a terminal", async () => {
    const h = harness(
      { "GET /api/cli/target": [json(running)] },
      { stdinIsTty: false }
    );
    h.run.mockResolvedValueOnce(3);
    expect(await h.exec("exec", ["--", "jq", "."])).toBe(3);
    const args = h.run.mock.calls[0][1];
    expect(args[1]).toBe("-i");
    expect(args).not.toContain("TERM=tmux-256color");
    expect(args.slice(-2)).toEqual(["jq", "."]);
  });

  it("runs exec through ssh for a remote node", async () => {
    const ssh = { control: "/s", dest: "tim@box" };
    const h = harness({
      "GET /api/cli/target": [
        json({ ...running, exec: { ...running.exec, ssh }, node: "box" }),
      ],
    });
    await h.exec("exec", ["fix", "--", "ls"]);
    expect(h.run.mock.calls[0][0]).toBe("ssh");
    expect(h.run.mock.calls[0][1]).toContain("tim@box");
  });

  it("refuses exec on a stopped environment and suggests up", async () => {
    const h = harness({ "GET /api/cli/target": [json(stopped)] });
    expect(await h.exec("exec", ["main", "--", "ls"])).toBe(1);
    expect(h.err).toEqual([
      "main (demo-abc123) is stopped; start it with `opendevhub up main`",
    ]);
    expect(h.run).not.toHaveBeenCalled();
  });

  it("needs a terminal to attach", async () => {
    const h = harness({}, { stdinIsTty: false });
    expect(await h.exec("attach")).toBe(2);
    expect(h.err[0]).toMatch(/opendevhub exec/u);
  });
});
