import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NotFoundError } from "../../../src/server/errors";
import { InvalidRequestError } from "../../../src/server/git/worktrees";
import {
  DevcontainerExistsError,
  Onboarding,
} from "../../../src/server/projects/onboarding";
import { renderDevcontainer } from "../../../src/shared/stacks";

let root: string;
let onboarding: Onboarding;
const repo = (rel: string) => {
  fs.mkdirSync(path.join(root, rel, ".git"), { recursive: true });
  return path.join(root, rel);
};
const spec = (dir: string) =>
  path.join(dir, ".devcontainer", "devcontainer.json");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "odh-onboard-"));
  onboarding = new Onboarding({ roots: () => [root] });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe(Onboarding, () => {
  it("lists the roots and candidates", async () => {
    const app = repo("app");
    await expect(onboarding.list()).resolves.toStrictEqual({
      roots: [root],
      candidates: [{ path: app, name: "app", root, stack: "generic" }],
    });
  });

  it("writes the template for the chosen stack and returns the candidate", async () => {
    const app = repo("app");
    const added = await onboarding.add(app, "rust");
    expect(added.path).toBe(app);
    expect(fs.readFileSync(spec(app), "utf-8")).toBe(
      renderDevcontainer("app", "rust")
    );
  });

  it("rejects an unknown stack before touching the disk", async () => {
    const app = repo("app");
    await expect(onboarding.add(app, "cobol")).rejects.toBeInstanceOf(
      InvalidRequestError
    );
    await expect(onboarding.add(app, undefined)).rejects.toBeInstanceOf(
      InvalidRequestError
    );
    expect(fs.existsSync(path.join(app, ".devcontainer"))).toBeFalsy();
  });

  it.each([
    ["a path outside the roots", () => path.join(os.tmpdir(), "elsewhere")],
    // String concatenation on purpose: path.join would normalise the .. away.
    ["a path with ..", () => `${root}/app/../app`],
    ["a trailing slash", () => `${path.join(root, "app")}/`],
    ["a relative path", () => "app"],
    [
      "a plain folder",
      () => (fs.mkdirSync(path.join(root, "plain")), path.join(root, "plain")),
    ],
    ["a repo below maxDepth", () => repo("a/b/c")],
    ["an empty path", () => ""],
  ])(
    "refuses %s with NotFoundError and writes nothing",
    async (_what, target) => {
      repo("app");
      const p = target();
      await expect(onboarding.add(p, "node")).rejects.toBeInstanceOf(
        NotFoundError
      );
      expect(fs.existsSync(spec(path.join(root, "app")))).toBeFalsy();
    }
  );

  it("refuses a repo that became a project since it was listed", async () => {
    const app = repo("app");
    fs.writeFileSync(path.join(app, ".devcontainer.json"), "{}");
    await expect(onboarding.add(app, "node")).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(fs.existsSync(spec(app))).toBeFalsy();
  });

  it("never overwrites a file that appears after the scan", async () => {
    const app = repo("app");
    const racing = new Onboarding({
      roots: () => [root],
      // The scan still sees a candidate, then another writer creates the file.
      scan: async () => {
        const found = [
          { path: app, name: "app", root, stack: "node" as const },
        ];
        fs.mkdirSync(path.join(app, ".devcontainer"));
        fs.writeFileSync(spec(app), "mine");
        return found;
      },
    });
    await expect(racing.add(app, "node")).rejects.toBeInstanceOf(
      DevcontainerExistsError
    );
    expect(fs.readFileSync(spec(app), "utf-8")).toBe("mine");
  });
});
