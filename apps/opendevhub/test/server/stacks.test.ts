import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectStack } from "../../src/server/stacks";

let dir: string;
const touch = (...names: string[]) => names.forEach((n) => fs.writeFileSync(path.join(dir, n), ""));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-stack-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("detectStack", () => {
  it.each([
    [["package.json"], "node"],
    [["pyproject.toml"], "python"],
    [["requirements.txt"], "python"],
    [["setup.py"], "python"],
    [["go.mod"], "go"],
    [["Cargo.toml"], "rust"],
    [["Gemfile"], "ruby"],
    [["pom.xml"], "java"],
    [["build.gradle.kts"], "java"],
    [["App.csproj"], "dotnet"],
    [["Solution.sln"], "dotnet"],
    [["composer.json"], "php"],
    [["README.md"], "generic"],
  ])("%j → %s", async (files, stack) => {
    touch(...files);
    expect(await detectStack(dir)).toBe(stack);
  });

  it("takes the first stack in table order when several match", async () => {
    touch("pyproject.toml", "package.json", "go.mod");
    expect(await detectStack(dir)).toBe("node");
  });

  it("ignores markers in subfolders and folders named like markers", async () => {
    fs.mkdirSync(path.join(dir, "web"));
    fs.writeFileSync(path.join(dir, "web", "package.json"), "");
    fs.mkdirSync(path.join(dir, "go.mod"));
    expect(await detectStack(dir)).toBe("generic");
  });

  it("falls back to generic for an unreadable folder", async () => {
    expect(await detectStack(path.join(dir, "missing"))).toBe("generic");
  });
});
