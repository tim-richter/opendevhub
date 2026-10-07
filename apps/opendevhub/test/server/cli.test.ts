import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadAndSaveStartupConfig,
  parseCli,
  proxyTargets,
  runNodesCommand,
} from "../../src/server/cli";
import { loadConfig, saveConfig, saveState } from "../../src/server/config";
import { StateStore } from "../../src/server/state";

describe(parseCli, () => {
  it("parses repeated roots, port and --no-open", () => {
    expect(
      parseCli([
        "--root",
        "~/code",
        "-r",
        "/work",
        "--port",
        "9000",
        "--no-open",
      ])
    ).toStrictEqual({
      roots: ["~/code", "/work"],
      port: 9000,
      open: false,
      help: false,
    });
  });

  it("defaults", () => {
    expect(parseCli([])).toStrictEqual({
      roots: [process.cwd()],
      port: undefined,
      open: true,
      help: false,
    });
  });

  it("defaults to the current directory with other options", () => {
    expect(parseCli(["--port", "8080", "--no-open"])).toStrictEqual({
      roots: [process.cwd()],
      port: 8080,
      open: false,
      help: false,
    });
  });

  it.each([["--port", "abc"], ["--port", "70000"], ["--bogus"]])(
    "rejects %s",
    (...argv) => {
      expect(() => parseCli(argv)).toThrow();
    }
  );
});

describe(loadAndSaveStartupConfig, () => {
  it.each([[], ["--root", "/other"]])(
    "does not persist roots for %j",
    (...argv) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-cli-"));
      try {
        const opts = parseCli(argv);
        loadAndSaveStartupConfig(dir, opts);
        expect(
          JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8"))
        ).toStrictEqual({ port: 7777 });
        expect(parseCli([]).roots).toStrictEqual([process.cwd()]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it("ignores and removes legacy saved roots while preserving other settings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-cli-"));
    try {
      const forges = { "git.example.com": { kind: "forgejo" } };
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ roots: ["/legacy"], port: 9000, forges })
      );
      expect(loadAndSaveStartupConfig(dir, parseCli([]))).toStrictEqual({
        port: 9000,
        forges,
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8"))
      ).toStrictEqual({ port: 9000, forges });
      expect(parseCli(["--root", "/other"]).roots).toStrictEqual(["/other"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps saved forges when saving the port", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-cli-"));
    try {
      saveConfig(dir, {
        port: 7777,
        forges: {
          "git.example.com": { kind: "forgejo" },
          gh: { kind: "github", web: "https://github.com" },
        },
      });
      loadAndSaveStartupConfig(dir, { port: 9000 });
      const reloaded = loadConfig(dir);
      expect(reloaded.port).toBe(9000);
      expect(reloaded.forges).toStrictEqual({
        "git.example.com": { kind: "forgejo" },
        gh: { kind: "github", web: "https://github.com" },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe(proxyTargets, () => {
  it("proxies to a running environment's opencode, main or task", () => {
    const store = new StateStore({
      port: 7777,
      persisted: { projects: {} },
      persist: () => {},
    });
    store.updateRuntime("p-feat-0a1b", {
      containerState: "running",
      password: "pw",
    });
    const addresses: Record<string, { host: string; port: number }> = {
      "p-feat-0a1b": { host: "172.17.0.10", port: 4096 },
    };
    const resolve = proxyTargets(store, {
      opencodeAddress: (id: string) => addresses[id],
    });
    expect(resolve("p-feat-0a1b")).toStrictEqual({
      host: "172.17.0.10",
      port: 4096,
      password: "pw",
    });
    expect(resolve("p")).toBeUndefined();
  });
});
describe(runNodesCommand, () => {
  it("won't remove a node that still runs task environments", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-cli-nodes-"));
    try {
      saveConfig(dir, { port: 7777, nodes: [{ id: "box", ssh: "tim@box" }] });
      const worktree = {
        path: "/workspaces/demo.worktrees/fix",
        hostPath: "/home/tim/x/fix",
        branch: "fix",
      };
      saveState(dir, {
        projects: {},
        environments: {
          "demo-fix-1a2b": { projectId: "demo", worktree, node: "box" },
        },
      });
      const err: string[] = [];
      expect(
        runNodesCommand(["remove", "box"], dir, {
          log: () => {},
          error: (s) => err.push(s),
        })
      ).toBe(2);
      expect(err).toStrictEqual([
        "node box still runs 1 task environment; remove it first",
      ]);
      expect(loadConfig(dir).nodes).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function run(dir: string, ...argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runNodesCommand(argv, dir, {
      log: (s) => out.push(s),
      error: (s) => err.push(s),
    });
    return { code, out, err };
  }

  it("adds, lists and removes nodes in config.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-cli-nodes-"));
    try {
      saveConfig(dir, { port: 7777 });
      expect(run(dir, "list").out).toStrictEqual([
        "No nodes yet. Add one: opendevhub nodes add user@host",
      ]);
      const added = run(dir, "add", "tim@box", "--label", "Box");
      expect(added.code).toBe(0);
      expect(added.out[0]).toMatch(/added node box \(tim@box\)/u);
      expect(run(dir, "list").out).toStrictEqual(["box\ttim@box\tBox"]);
      expect(run(dir, "remove", "box").code).toBe(0);
      expect(loadConfig(dir).nodes).toBeUndefined();
      expect(loadConfig(dir).port).toBe(7777);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [["add"]],
    [["add", "a", "b"]],
    [["add", "-oProxyCommand=x"]],
    [["remove", "nope"]],
    [["bogus"]],
    [[]],
  ])("fails with exit 2 for %j", (argv) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-cli-nodes-"));
    try {
      const r = run(dir, ...argv);
      expect(r.code).toBe(2);
      expect(r.err.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
