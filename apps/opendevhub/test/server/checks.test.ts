import { describe, expect, it, vi } from "vitest";
import type { CheckRun, Project } from "../../src/shared/types";
import {
  type CheckTarget,
  Checks,
  ChecksRunningError,
  type ChecksDeps,
  composeProjectName,
  hostCheckHash,
  parseChecks,
  parseJsonc,
  resolveChecks,
} from "../../src/server/checks";
import type { ProjectSettingsStore } from "../../src/server/config";
import type { RunOptions, RunResult } from "../../src/server/exec";
import { InvalidRequestError } from "../../src/server/worktrees";
import { NotFoundError } from "../../src/server/orchestrator";

describe("parseChecks", () => {
  it("fills in defaults and keeps valid entries", () => {
    expect(parseChecks([{ name: " lint ", command: "pnpm lint" }, { name: "img", command: "docker build .", where: "host", timeout: 60 }])).toEqual({
      checks: [
        { name: "lint", command: "pnpm lint", where: "container", timeout: 900 },
        { name: "img", command: "docker build .", where: "host", timeout: 60 },
      ],
      errors: [],
    });
  });

  it("drops invalid entries and says why", () => {
    const { checks, errors } = parseChecks([
      "x",
      { command: "true" },
      { name: "a", command: "" },
      { name: "b", command: "true", where: "cloud" },
      { name: "c", command: "true", timeout: 5 },
      { name: "d", command: "true" },
      { name: "d", command: "false" },
    ]);
    expect(checks.map((c) => c.name)).toEqual(["d"]);
    expect(errors).toEqual([
      "check #1: must be an object",
      "check #2: needs a name of 1 to 40 characters",
      'check "a": needs a command of 1 to 4000 characters',
      'check "b": where must be "container" or "host"',
      'check "c": timeout must be whole seconds from 10 to 7200',
      'check "d": the name is used twice',
    ]);
  });

  it("treats a missing list as none and anything else as an error", () => {
    expect(parseChecks(undefined)).toEqual({ checks: [], errors: [] });
    expect(parseChecks({})).toEqual({ checks: [], errors: ["checks must be a list"] });
  });
});

describe("parseJsonc", () => {
  it("allows comments and trailing commas, but not inside strings", () => {
    const text = `{
      // a comment
      "url": "http://x/*not a comment*/", /* block */
      "list": [1, 2,],
      "s": "a \\" // b",
    }`;
    expect(parseJsonc(text)).toEqual({ url: "http://x/*not a comment*/", list: [1, 2], s: 'a " // b' });
  });
});

describe("resolveChecks", () => {
  const custom = { checks: [{ name: "test", command: "pnpm test" }, { name: "img", command: "docker build .", where: "host" }] };

  it("uses devcontainer.json and marks unapproved host commands", () => {
    const r = resolveChecks(custom, {});
    expect(r.source).toBe("devcontainer");
    expect(r.checks.map((c) => [c.name, c.approved])).toEqual([
      ["test", true],
      ["img", false],
    ]);
    expect(resolveChecks(custom, { approvedHostChecks: [hostCheckHash("docker build .")] }).checks[1].approved).toBe(true);
  });

  it("lets the project's settings replace the list, even with an empty one", () => {
    const r = resolveChecks(custom, { checks: [] });
    expect(r).toMatchObject({ source: "settings", checks: [], settings: [] });
    expect(r.devcontainer).toHaveLength(2);
    expect(resolveChecks(undefined, {}).source).toBe("none");
  });

  it("prefixes errors with where they came from", () => {
    expect(resolveChecks({ checks: [{}] }, { checks: "x" }, ["read failed"]).errors).toEqual([
      "read failed",
      "devcontainer.json: check #1: needs a name of 1 to 40 characters",
      "settings: checks must be a list",
    ]);
  });
});

describe("hostCheckHash / composeProjectName", () => {
  it("hashes the exact command", () => {
    expect(hostCheckHash("a")).toMatch(/^[0-9a-f]{64}$/);
    expect(hostCheckHash("a")).not.toBe(hostCheckHash("a "));
  });

  it("makes a name docker compose accepts", () => {
    expect(composeProjectName("/src/My App", "feat/Login_page")).toBe("my-app-feat-login_page");
  });
});

const project: Project = { id: "demo", name: "demo", path: "/src/demo", devcontainerPath: "/src/demo/.devcontainer/devcontainer.json" };

class MemorySettings implements ProjectSettingsStore {
  data: Record<string, Record<string, unknown>> = {};
  get(p: string) {
    return this.data[p] ?? {};
  }
  update(p: string, patch: Record<string, unknown>) {
    const entry = { ...this.get(p), ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete entry[k];
    this.data[p] = entry;
  }
}

type Exec = (command: string[], opts: { env?: Record<string, string>; onLine?: (l: string) => void }) => Partial<RunResult>;

function setup(
  opts: { checks?: unknown; target?: Partial<CheckTarget>; exec?: Exec; host?: (cmd: string, opts: RunOptions) => Partial<RunResult>; execMs?: number } = {},
) {
  const settings = new MemorySettings();
  const log: string[] = [];
  const execCalls: { command: string[]; env?: Record<string, string> }[] = [];
  const hostCalls: { args: string[]; opts: RunOptions }[] = [];
  let clock = 1000;
  const state = { head: "abc", clean: true };
  const file = JSON.stringify({ customizations: { opendevhub: { checks: opts.checks ?? [{ name: "lint", command: "pnpm lint" }, { name: "test", command: "pnpm test" }] } } });
  const target: CheckTarget = {
    project,
    exec: project,
    checkout: { container: "/workspaces/demo", host: "/src/demo" },
    isMain: true,
    ...opts.target,
  };
  const deps: ChecksDeps = {
    target: (id, dir) => {
      if (id !== "demo") throw new NotFoundError(id);
      if (dir !== target.checkout.container) throw new InvalidRequestError(`${dir} is neither the workspace nor a known worktree`);
      return target;
    },
    project: (id) => (id === "demo" ? project : undefined),
    containers: {
      exec: async (_t, command, o = {}) => {
        execCalls.push({ command, env: o.env });
        clock += opts.execMs ?? 2000;
        const r = (opts.exec ?? (() => ({})))(command, o);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...r };
      },
    },
    run: async (_cmd, args, o = {}) => {
      hostCalls.push({ args, opts: o });
      const r = (opts.host ?? (() => ({})))(args[1], o);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...r };
    },
    git: {
      head: async () => state.head,
      isClean: async () => state.clean,
      currentBranch: async () => "feature",
    },
    settings,
    log: (_id, line) => log.push(line),
    readFile: async () => file,
    now: () => clock,
    env: {},
  };
  const checks = new Checks(deps);
  const finished = async (dir = "/workspaces/demo"): Promise<CheckRun> => {
    await vi.waitFor(() => {
      if (!checks.latest("demo", dir).run?.finishedAt) throw new Error("still running");
    });
    return checks.latest("demo", dir).run!;
  };
  return { checks, settings, log, execCalls, hostCalls, state, finished };
}

describe("Checks", () => {
  it("runs every check in the container, in order, and records the result", async () => {
    const { checks, execCalls, log, finished } = setup({
      exec: (command, o) => {
        o.onLine?.("\x1b[31mred\x1b[0m line");
        return command.at(-1) === "pnpm test" ? { exitCode: 1 } : {};
      },
    });
    const started = await checks.start("demo", "/workspaces/demo");
    expect(started.results.map((r) => r.status)).toEqual(["queued", "queued"]);
    const run = await finished();
    expect(run).toMatchObject({ head: "abc", dirty: false });
    expect(run.results.map((r) => [r.name, r.status, r.exitCode, r.durationMs])).toEqual([
      ["lint", "passed", 0, 2000],
      ["test", "failed", 1, 2000],
    ]);
    expect(run.results[0].output).toEqual(["red line"]);
    expect(execCalls[0].command.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(execCalls[0].command.slice(3)).toEqual(["sh", "/workspaces/demo", "900", "pnpm lint"]);
    expect(execCalls[0].env).toEqual({ OPENDEVHUB_CHECK: "lint", OPENDEVHUB_BRANCH: "feature" });
    expect(log).toEqual(["checks: lint passed in 2.0 s", "checks: test failed (exit 1) in 2.0 s"]);
  });

  it("reports a check that ran out of time", async () => {
    const { checks, finished } = setup({ checks: [{ name: "slow", command: "sleep 99", timeout: 10 }], exec: () => ({ timedOut: true, exitCode: 143 }) });
    await checks.start("demo", "/workspaces/demo");
    expect((await finished()).results[0]).toMatchObject({ status: "failed", timedOut: true });
  });

  it("treats `timeout`'s exit code after the deadline as timed out", async () => {
    const checks = [{ name: "slow", command: "sleep 99", timeout: 10 }];
    const late = setup({ checks, exec: () => ({ exitCode: 124 }), execMs: 10_000 });
    await late.checks.start("demo", "/workspaces/demo");
    expect((await late.finished()).results[0]).toMatchObject({ status: "failed", timedOut: true, exitCode: 124 });
    // The command's own exit code 124, well before the deadline, is just a failure.
    const early = setup({ checks, exec: () => ({ exitCode: 124 }) });
    await early.checks.start("demo", "/workspaces/demo");
    expect((await early.finished()).results[0].timedOut).toBeUndefined();
  });

  it("refuses a second run in the same checkout while one goes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { checks, finished } = setup();
    // Hold the first exec until released.
    (checks as unknown as { deps: ChecksDeps }).deps.containers.exec = async () => {
      await gate;
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    await checks.start("demo", "/workspaces/demo");
    await expect(checks.start("demo", "/workspaces/demo")).rejects.toBeInstanceOf(ChecksRunningError);
    release();
    await finished();
    await expect(checks.start("demo", "/workspaces/demo")).resolves.toBeDefined();
  });

  it("validates the directory and the names", async () => {
    const { checks } = setup();
    await expect(checks.start("demo", "/etc")).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(checks.start("demo", "/workspaces/demo", { names: ["nope"] })).rejects.toThrow("unknown check nope");
    const none = setup({ checks: [] });
    await expect(none.checks.start("demo", "/workspaces/demo")).rejects.toThrow("this project has no checks");
  });

  it("marks container checks as errors when the environment isn't running", async () => {
    const { checks, finished, execCalls } = setup({ target: { unavailable: "the project's container is not running" } });
    await checks.start("demo", "/workspaces/demo");
    const run = await finished();
    expect(run.results.map((r) => [r.status, r.reason])).toEqual([
      ["error", "the project's container is not running"],
      ["error", "the project's container is not running"],
    ]);
    expect(execCalls).toHaveLength(0);
  });

  describe("host checks", () => {
    const hostChecks = [{ name: "img", command: "docker compose build", where: "host" }];

    it("refuses to run an unapproved command, and approving it runs it", async () => {
      const { checks, hostCalls, settings, finished } = setup({ checks: hostChecks });
      await expect(checks.start("demo", "/workspaces/demo")).rejects.toThrow("approve the host command of img before running it");
      expect(hostCalls).toHaveLength(0);
      await checks.start("demo", "/workspaces/demo", { approve: ["docker compose build", "rm -rf /"] });
      expect(settings.get("/src/demo").approvedHostChecks).toEqual([hostCheckHash("docker compose build")]);
      expect((await finished()).results[0].status).toBe("passed");
      expect(hostCalls[0].args).toEqual(["-c", "docker compose build"]);
      expect(hostCalls[0].opts).toMatchObject({ cwd: "/src/demo", detached: true, timeoutMs: 900_000 });
      expect(hostCalls[0].opts.env).toEqual({ OPENDEVHUB_CHECK: "img", OPENDEVHUB_BRANCH: "feature" });
    });

    it("gives a worktree its own compose project", async () => {
      const { checks, hostCalls, settings, finished } = setup({
        checks: hostChecks,
        target: { isMain: false, checkout: { container: "/workspaces/demo.worktrees/f", host: "/src/demo.worktrees/f" } },
      });
      settings.update("/src/demo", { approvedHostChecks: [hostCheckHash("docker compose build")] });
      await checks.start("demo", "/workspaces/demo.worktrees/f");
      await finished("/workspaces/demo.worktrees/f");
      expect(hostCalls[0].opts.env?.COMPOSE_PROJECT_NAME).toBe("demo-feature");
    });

    it("can't run where the checkout isn't on this machine", async () => {
      const { checks, settings, finished } = setup({ checks: hostChecks, target: { checkout: { container: "/workspaces/demo" } } });
      settings.update("/src/demo", { approvedHostChecks: [hostCheckHash("docker compose build")] });
      await checks.start("demo", "/workspaces/demo");
      expect((await finished()).results[0]).toMatchObject({ status: "error", reason: expect.stringContaining("isn't on this machine") });
    });
  });

  it("says whether the latest run still describes the checkout", async () => {
    const { checks, state, finished } = setup();
    expect((await checks.view("demo", "/workspaces/demo")).run).toBeUndefined();
    await checks.start("demo", "/workspaces/demo");
    await finished();
    expect((await checks.view("demo", "/workspaces/demo")).current).toBe(true);
    state.clean = false;
    expect((await checks.view("demo", "/workspaces/demo")).current).toBe(false);
    state.clean = true;
    state.head = "def";
    expect((await checks.view("demo", "/workspaces/demo")).current).toBe(false);
  });

  it("re-runs one check and keeps the others' results while the commit is the same", async () => {
    let fail = true;
    const { checks, state, finished } = setup({ exec: (c) => (c.at(-1) === "pnpm test" && fail ? { exitCode: 1 } : {}) });
    await checks.start("demo", "/workspaces/demo");
    await finished();
    fail = false;
    await checks.start("demo", "/workspaces/demo", { names: ["test"] });
    expect((await finished()).results.map((r) => [r.name, r.status])).toEqual([
      ["lint", "passed"],
      ["test", "passed"],
    ]);
    state.head = "def";
    await checks.start("demo", "/workspaces/demo", { names: ["test"] });
    expect((await finished()).results.map((r) => r.name)).toEqual(["test"]);
  });

  it("saves the project's own list, approving its host commands, and removes it again", async () => {
    const { checks, settings } = setup();
    const saved = await checks.saveSettings("demo", [{ name: "img", command: "docker build .", where: "host" }]);
    expect(saved).toMatchObject({ source: "settings", checks: [{ name: "img", approved: true }] });
    expect(settings.get("/src/demo").checks).toEqual([{ name: "img", command: "docker build .", where: "host", timeout: 900 }]);
    await expect(checks.saveSettings("demo", [{ name: "" }])).rejects.toBeInstanceOf(InvalidRequestError);
    expect((await checks.saveSettings("demo", null)).source).toBe("devcontainer");
    expect(settings.get("/src/demo").checks).toBeUndefined();
  });

  it("reports a devcontainer.json it can't read", async () => {
    const { checks } = setup();
    (checks as unknown as { deps: ChecksDeps }).deps.readFile = async () => "{ nope";
    const config = await checks.config("demo");
    expect(config.source).toBe("none");
    expect(config.errors[0]).toMatch(/^could not read \/src\/demo\/.devcontainer\/devcontainer.json/);
    await expect(checks.config("nope")).rejects.toBeInstanceOf(NotFoundError);
  });
});
