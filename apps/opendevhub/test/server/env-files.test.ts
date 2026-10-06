import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvFiles } from "../../src/server/env-files";
import { localHost } from "../../src/server/host";
import { fakeRunner } from "../helpers/fake-runner";

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
  it("writes and removes through a host", async () => {
    const written: Array<[string, string]> = [];
    const fake = fakeRunner();
    const host = { ...localHost(fake.run), writeFile: async (f: string, c: string) => void written.push([f, c]) };
    const files = new EnvFiles("/home/tim/.opendevhub/envs", host);
    expect(await files.write("demo-feat-0a1b", { image: "x" })).toBe("/home/tim/.opendevhub/envs/demo-feat-0a1b/devcontainer.json");
    expect(written).toEqual([["/home/tim/.opendevhub/envs/demo-feat-0a1b/devcontainer.json", '{\n  "image": "x"\n}\n']]);
    await files.remove("demo-feat-0a1b");
    expect(fake.calls).toEqual([{ cmd: "rm", args: ["-rf", "--", "/home/tim/.opendevhub/envs/demo-feat-0a1b"], opts: { timeoutMs: 30_000 } }]);
  });

  it("refuses ids that aren't env ids", () => {
    expect(() => new EnvFiles(dir).path("../x")).toThrow(/invalid environment id/);
  });
});
