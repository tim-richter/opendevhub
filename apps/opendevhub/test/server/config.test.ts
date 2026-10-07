import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PORT,
  InvalidNodeError,
  addNode,
  nodeIdFor,
  removeNode,
  validateSshDestination,
  configDir,
  FileForgeStore,
  FileProjectSettings,
  loadConfig,
  loadState,
  resolveRoots,
  saveConfig,
  saveState,
  stateDir,
} from "../../src/server/config";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-config-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe(configDir, () => {
  it("uses XDG_CONFIG_HOME when absolute", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/opendevhub");
  });

  it("falls back to ~/.config", () => {
    expect(configDir({})).toBe(
      path.join(os.homedir(), ".config", "opendevhub")
    );
  });
});

describe("config", () => {
  it("returns defaults when missing", () => {
    expect(loadConfig(dir)).toStrictEqual({ port: DEFAULT_PORT });
  });

  it("round-trips", () => {
    saveConfig(dir, { port: 9000 });
    expect(loadConfig(dir)).toStrictEqual({ port: 9000 });
  });

  it("backs up a corrupt file and starts fresh", () => {
    fs.writeFileSync(path.join(dir, "config.json"), "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig(dir)).toStrictEqual({ port: DEFAULT_PORT });
    expect(fs.existsSync(path.join(dir, "config.json.bak"))).toBeTruthy();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("state", () => {
  it("round-trips and is written with mode 0600", () => {
    saveState(dir, {
      projects: {
        p1: { containerId: "c", password: "s", workspaceFolder: "/w" },
      },
    });
    expect(loadState(dir)).toStrictEqual({
      projects: {
        p1: { containerId: "c", password: "s", workspaceFolder: "/w" },
      },
    });
    expect(fs.statSync(path.join(dir, "state.json")).mode & 0o777).toBe(0o600);
  });

  it("defaults when missing", () => {
    expect(loadState(dir)).toStrictEqual({ projects: {} });
  });
});

describe(resolveRoots, () => {
  it("resolves, expands ~ and dedupes preserving order", () => {
    expect(
      resolveRoots(["/a", "/b", "/b", "rel", "~/code"], "/cwd")
    ).toStrictEqual(["/a", "/b", "/cwd/rel", path.join(os.homedir(), "code")]);
  });
});

describe(FileForgeStore, () => {
  it("keeps forges in config.json next to the other settings", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-forges-"));
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({
          port: 7777,
          forges: { "git.example.com": { kind: "forgejo" } },
        })
      );
      const store = new FileForgeStore(dir);
      expect(store.all()).toStrictEqual({
        "git.example.com": { kind: "forgejo" },
      });
      store.remember("gitea.example.com", { kind: "gitea" });
      const saved = JSON.parse(
        fs.readFileSync(path.join(dir, "config.json"), "utf-8")
      );
      expect(saved).toStrictEqual({
        port: 7777,
        forges: {
          "git.example.com": { kind: "forgejo" },
          "gitea.example.com": { kind: "gitea" },
        },
      });
      expect(new FileForgeStore(dir).all()["gitea.example.com"]).toStrictEqual({
        kind: "gitea",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores malformed forge entries", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-forges-"));
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({
          forges: {
            a: { kind: "nope" },
            b: "x",
            c: { kind: "gitlab", web: 3 },
          },
        })
      );
      expect(new FileForgeStore(dir).all()).toStrictEqual({
        c: { kind: "gitlab" },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config forges", () => {
  it("survives the CLI's load and save on start", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-forges-"));
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ port: 1, forges: { h: { kind: "gitea" } } })
      );
      saveConfig(dir, loadConfig(dir));
      expect(
        JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8"))
          .forges
      ).toStrictEqual({ h: { kind: "gitea" } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config projects", () => {
  it("keeps per-project settings through the CLI's load and save", () => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        port: 1,
        projects: { "/src/demo": { isolation: "isolated" } },
      })
    );
    saveConfig(dir, loadConfig(dir));
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8"))
        .projects
    ).toStrictEqual({ "/src/demo": { isolation: "isolated" } });
  });
});

describe(stateDir, () => {
  it("uses XDG_STATE_HOME when absolute, else ~/.local/state", () => {
    expect(stateDir({ XDG_STATE_HOME: "/xdg" })).toBe("/xdg/opendevhub");
    expect(stateDir({ XDG_STATE_HOME: "rel" })).toBe(
      path.join(os.homedir(), ".local", "state", "opendevhub")
    );
  });
});

describe("persisted environments", () => {
  it("round-trips task environments in state.json", () => {
    const state = {
      projects: {},
      environments: {
        "demo-feat-0a1b": {
          projectId: "demo",
          worktree: {
            path: "/w/demo.worktrees/feat",
            hostPath: "/src/demo.worktrees/feat",
            branch: "feat",
          },
          containerId: "c2",
        },
      },
    };
    saveState(dir, state);
    expect(loadState(dir)).toStrictEqual(state);
  });
});

describe(FileProjectSettings, () => {
  it("updates one project's entry and keeps the rest of config.json", () => {
    saveConfig(dir, {
      port: 1,
      projects: { "/a": { sshAgent: false }, "/b": { isolation: "isolated" } },
    });
    const settings = new FileProjectSettings(dir);
    settings.update("/a", { checks: [{ name: "t", command: "true" }] });
    expect(settings.get("/a")).toStrictEqual({
      sshAgent: false,
      checks: [{ name: "t", command: "true" }],
    });
    expect(loadConfig(dir)).toMatchObject({
      projects: { "/b": { isolation: "isolated" } },
    });
  });

  it("removes keys set to undefined and reads a missing entry as empty", () => {
    const settings = new FileProjectSettings(dir);
    expect(settings.get("/x")).toStrictEqual({});
    settings.update("/x", { checks: [], sshAgent: true });
    settings.update("/x", { checks: undefined });
    expect(settings.get("/x")).toStrictEqual({ sshAgent: true });
  });
});
describe("nodes in config", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "odh-nodes-"));

  it("loads valid nodes and drops invalid ones", () => {
    const dir = tmp();
    try {
      fs.writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({
          port: 7777,
          nodes: [
            { id: "box", ssh: "tim@box", label: "Workstation" },
            { id: "local", ssh: "tim@other" },
            { id: "Bad_ID", ssh: "tim@x" },
            { id: "evil", ssh: "-oProxyCommand=touch /tmp/pwned" },
            { id: "box", ssh: "tim@dupe" },
            "junk",
          ],
        })
      );
      expect(loadConfig(dir).nodes).toStrictEqual([
        { id: "box", ssh: "tim@box", label: "Workstation" },
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips nodes through saveConfig", () => {
    const dir = tmp();
    try {
      saveConfig(dir, { port: 7777, nodes: [{ id: "box", ssh: "box" }] });
      expect(loadConfig(dir).nodes).toStrictEqual([{ id: "box", ssh: "box" }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    ["-oProxyCommand=touch /tmp/x"],
    ["-p"],
    ["tim@box extra"],
    ["tim@box\n-oFoo=bar"],
    [""],
    ["   "],
  ])("rejects the ssh destination %j", (dest) => {
    expect(() => validateSshDestination(dest)).toThrow(InvalidNodeError);
  });

  it("accepts and trims usual destinations", () => {
    expect(validateSshDestination(" tim@box.lan ")).toBe("tim@box.lan");
    expect(validateSshDestination("build-1")).toBe("build-1");
    expect(validateSshDestination("tim@[fe80::1]")).toBe("tim@[fe80::1]");
  });

  it.each([
    ["tim@box.lan", [], "box-lan"],
    ["My Box", [], "my-box"],
    ["box", ["box"], "box-2"],
    ["box", ["box", "box-2"], "box-3"],
    ["local", [], "local-2"],
    ["@@@", [], "node"],
    ["tim@host:2222", [], "host"],
  ])("nodeIdFor(%j, %j) = %s", (name, taken, id) => {
    expect(nodeIdFor(name, taken)).toBe(id);
  });

  it("adds a node with an id from its label, and refuses the same destination twice", () => {
    const base = { port: 7777 };
    const { config, node } = addNode(base, {
      ssh: "tim@box",
      label: " Workstation ",
    });
    expect(node).toStrictEqual({
      id: "workstation",
      ssh: "tim@box",
      label: "Workstation",
    });
    expect(config.nodes).toStrictEqual([node]);
    expect(() => addNode(config, { ssh: "tim@box" })).toThrow(
      /already a node/u
    );
    expect(addNode(config, { ssh: "tim@other" }).node).toStrictEqual({
      id: "other",
      ssh: "tim@other",
    });
  });

  it("removes a node by id", () => {
    const cfg = {
      port: 7777,
      nodes: [
        { id: "a", ssh: "a" },
        { id: "b", ssh: "b" },
      ],
    };
    expect(removeNode(cfg, "a").nodes).toStrictEqual([{ id: "b", ssh: "b" }]);
  });
});
