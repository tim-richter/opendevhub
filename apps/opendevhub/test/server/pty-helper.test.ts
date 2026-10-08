import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureSpawnHelperExecutable } from "../../src/server/pty-helper";

const fakePty = (mode: number) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "odh-pty-"));
  const dir = path.join(root, "prebuilds", "darwin-arm64");
  fs.mkdirSync(dir, { recursive: true });
  const helper = path.join(dir, "spawn-helper");
  fs.writeFileSync(helper, "");
  fs.chmodSync(helper, mode);
  return { helper, root };
};

describe(ensureSpawnHelperExecutable, () => {
  it("restores the execute bit node-pty's prebuild ships without", () => {
    const { helper, root } = fakePty(0o644);
    expect(ensureSpawnHelperExecutable(root, "darwin", "arm64")).toStrictEqual([
      helper,
    ]);
    expect(fs.statSync(helper).mode & 0o777).toBe(0o755);
  });

  it("leaves an executable helper alone", () => {
    const { root } = fakePty(0o755);
    expect(ensureSpawnHelperExecutable(root, "darwin", "arm64")).toStrictEqual(
      []
    );
  });

  it("ignores missing helpers and Windows", () => {
    const { root } = fakePty(0o644);
    expect(ensureSpawnHelperExecutable(root, "darwin", "x64")).toStrictEqual(
      []
    );
    expect(ensureSpawnHelperExecutable(root, "win32", "arm64")).toStrictEqual(
      []
    );
  });
});
