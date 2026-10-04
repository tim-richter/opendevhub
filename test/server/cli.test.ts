import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadAndSaveStartupConfig, parseCli } from "../../src/server/cli";
import { loadConfig, saveConfig } from "../../src/server/config";

describe("parseCli", () => {
  it("parses repeated roots, port and --no-open", () => {
    expect(parseCli(["--root", "~/code", "-r", "/work", "--port", "9000", "--no-open"])).toEqual({
      roots: ["~/code", "/work"],
      port: 9000,
      open: false,
      help: false,
    });
  });
  it("defaults", () => {
    expect(parseCli([])).toEqual({ roots: [], port: undefined, open: true, help: false });
  });
  it.each([["--port", "abc"], ["--port", "70000"], ["--bogus"]])("rejects %s", (...argv) => {
    expect(() => parseCli(argv)).toThrow();
  });
});

describe("loadAndSaveStartupConfig", () => {
  it("keeps saved forges when merging roots and saving", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-cli-"));
    try {
      saveConfig(dir, { roots: ["/a"], port: 7777, forges: { "git.example.com": { kind: "forgejo" }, gh: { kind: "github", web: "https://github.com" } } });
      const config = loadAndSaveStartupConfig(dir, { roots: ["/b"], port: 9000 });
      expect(config.roots).toEqual(["/a", "/b"]);
      const reloaded = loadConfig(dir);
      expect(reloaded.port).toBe(9000);
      expect(reloaded.forges).toEqual({ "git.example.com": { kind: "forgejo" }, gh: { kind: "github", web: "https://github.com" } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
