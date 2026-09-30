import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PORT,
  configDir,
  loadConfig,
  loadState,
  mergeRoots,
  saveConfig,
  saveState,
} from "../../src/server/config";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-config-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("configDir", () => {
  it("uses XDG_CONFIG_HOME when absolute", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/opendevhub");
  });
  it("falls back to ~/.config", () => {
    expect(configDir({})).toBe(path.join(os.homedir(), ".config", "opendevhub"));
  });
});

describe("config", () => {
  it("returns defaults when missing", () => {
    expect(loadConfig(dir)).toEqual({ roots: [], port: DEFAULT_PORT });
  });
  it("round-trips", () => {
    saveConfig(dir, { roots: ["/a"], port: 9000 });
    expect(loadConfig(dir)).toEqual({ roots: ["/a"], port: 9000 });
  });
  it("backs up a corrupt file and starts fresh", () => {
    fs.writeFileSync(path.join(dir, "config.json"), "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig(dir)).toEqual({ roots: [], port: DEFAULT_PORT });
    expect(fs.existsSync(path.join(dir, "config.json.bak"))).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("state", () => {
  it("round-trips and is written with mode 0600", () => {
    saveState(dir, { projects: { p1: { containerId: "c", password: "s", workspaceFolder: "/w" } } });
    expect(loadState(dir)).toEqual({
      projects: { p1: { containerId: "c", password: "s", workspaceFolder: "/w" } },
    });
    expect(fs.statSync(path.join(dir, "state.json")).mode & 0o777).toBe(0o600);
  });
  it("defaults when missing", () => {
    expect(loadState(dir)).toEqual({ projects: {} });
  });
});

describe("mergeRoots", () => {
  it("resolves, expands ~ and dedupes preserving order", () => {
    expect(mergeRoots(["/a", "/b"], ["/b", "rel", "~/code"], "/cwd")).toEqual([
      "/a",
      "/b",
      "/cwd/rel",
      path.join(os.homedir(), "code"),
    ]);
  });
});
