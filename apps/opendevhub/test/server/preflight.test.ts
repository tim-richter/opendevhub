import { describe, expect, it } from "vitest";

import { preflight } from "../../src/server/preflight";
import { fakeRunner } from "../helpers/fake-runner";

describe(preflight, () => {
  it("passes when docker and devcontainer work", async () => {
    await expect(preflight(fakeRunner().run)).resolves.toStrictEqual({
      errors: [],
    });
  });

  it("reports a missing docker CLI, an unreachable daemon and a missing devcontainer CLI", async () => {
    const missing = fakeRunner(() => ({ exitCode: 127 }));
    expect((await preflight(missing.run)).errors).toStrictEqual([
      "docker CLI not found on PATH",
      "devcontainer CLI not found on PATH — install it with `npm i -g @devcontainers/cli`",
    ]);
    const down = fakeRunner((c) => (c.cmd === "docker" ? { exitCode: 1 } : {}));
    expect((await preflight(down.run)).errors).toStrictEqual([
      "Docker daemon is not reachable — is Docker running?",
    ]);
  });
});
