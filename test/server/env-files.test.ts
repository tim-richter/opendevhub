import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvFiles } from "../../src/server/env-files";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-envs-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("EnvFiles", () => {
  it("writes, locates and removes an environment's config", async () => {
    const files = new EnvFiles(dir);
    const file = await files.write("demo-feat-0a1b", { image: "x" });
    expect(file).toBe(path.join(dir, "demo-feat-0a1b", "devcontainer.json"));
    expect(files.path("demo-feat-0a1b")).toBe(file);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ image: "x" });
    await files.remove("demo-feat-0a1b");
    expect(fs.existsSync(path.join(dir, "demo-feat-0a1b"))).toBe(false);
  });
  it("refuses ids that aren't env ids", () => {
    expect(() => new EnvFiles(dir).path("../x")).toThrow(/invalid environment id/);
  });
});
