import { describe, expect, it } from "vitest";

import { CommandError } from "../../../src/server/environments/containers";
import { UnavailableError } from "../../../src/server/errors";
import type { BaseState } from "../../../src/server/git/ops";
import { InvalidRequestError } from "../../../src/server/git/worktrees";
import { project, setup } from "../../helpers/hub";

const WS = "/workspaces/demo";

const state =
  (update: BaseState["update"], extra: Partial<BaseState> = {}) =>
  async (): Promise<BaseState> => ({
    ahead: 0,
    behind: update.kind === "ff" ? update.commits : 0,
    remote: "origin",
    update,
    upstream: "origin/main",
    ...extra,
  });

async function started() {
  const s = setup();
  await s.hub.environments.rescan();
  await s.hub.environments.start(project.id);
  return s;
}

describe("base positions", () => {
  it("fetches, then says a clean stale main would be fast-forwarded, without moving it", async () => {
    const s = await started();
    s.git.updateBase.mockImplementation(state({ commits: 5, kind: "ff" }));
    await expect(
      s.hub.bases.position(project.id, undefined)
    ).resolves.toStrictEqual({
      ahead: 0,
      base: "main",
      behind: 5,
      lastFetchAt: s.clock.now,
      remote: "origin",
      update: { commits: 5, kind: "ff" },
      upstream: "origin/main",
    });
    expect(s.git.fetchPrune).toHaveBeenCalledWith(project, WS, "origin");
    expect(s.git.updateBase).toHaveBeenCalledWith(project, WS, "main", {
      dryRun: true,
    });
  });

  it("passes on each reason git gives for not updating", async () => {
    const s = await started();
    for (const reason of ["dirty", "diverged", "no-upstream"] as const) {
      s.git.updateBase.mockImplementation(state({ kind: "skip", reason }));
      await expect(
        s.hub.bases.position(project.id, "main")
      ).resolves.toMatchObject({ update: { kind: "skip", reason } });
    }
    s.git.updateBase.mockImplementation(state({ kind: "up-to-date" }));
    await expect(
      s.hub.bases.position(project.id, "main")
    ).resolves.toMatchObject({ update: { kind: "up-to-date" } });
  });

  it("says the base won't be updated when the setting is off", async () => {
    const s = await started();
    s.preferences.mockReturnValue({ updateBaseBeforeTask: false });
    s.git.updateBase.mockImplementation(state({ commits: 2, kind: "ff" }));
    await expect(
      s.hub.bases.position(project.id, "main")
    ).resolves.toMatchObject({
      behind: 2,
      update: { kind: "skip", reason: "disabled" },
    });
  });

  it("reports a failed fetch with the last good one", async () => {
    const s = await started();
    await s.hub.bases.position(project.id, "main");
    const fetched = s.clock.now;
    s.clock.now += 10 * 60_000;
    s.git.fetchPrune.mockRejectedValueOnce(
      new CommandError("git fetch origin timed out after 60 s")
    );
    s.git.updateBase.mockImplementation(state({ commits: 1, kind: "ff" }));
    await expect(
      s.hub.bases.position(project.id, "main")
    ).resolves.toMatchObject({
      fetchError: "git fetch origin timed out after 60 s",
      lastFetchAt: fetched,
      update: { kind: "skip", reason: "fetch-failed" },
    });
  });

  it("answers a second read within five minutes from the refs already fetched, unless asked to fetch", async () => {
    const s = await started();
    const first = await s.hub.bases.position(project.id, "main");
    s.clock.now += 60_000;
    const second = await s.hub.bases.position(project.id, "main");
    expect(s.git.fetchPrune).toHaveBeenCalledOnce();
    expect(second.lastFetchAt).toBe(first.lastFetchAt);
    s.clock.now += 30_000;
    const forced = await s.hub.bases.position(project.id, "main", {
      fetch: true,
    });
    expect(s.git.fetchPrune).toHaveBeenCalledTimes(2);
    expect(forced.lastFetchAt).toBe(s.clock.now);
  });

  it("counts what the upstream gained since a branch was made", async () => {
    const s = await started();
    s.git.branchVsUpstream.mockResolvedValue({ ahead: 3, behind: 4 });
    await expect(
      s.hub.bases.position(project.id, "main", { branch: "fix" })
    ).resolves.toMatchObject({ branchAhead: 3, sinceBranch: 4 });
    expect(s.git.branchVsUpstream).toHaveBeenCalledWith(
      project,
      WS,
      "fix",
      "refs/remotes/origin/main"
    );
  });

  it("refuses a bad base, a detached main checkout and a stopped project", async () => {
    const s = await started();
    await expect(
      s.hub.bases.position(project.id, "--upload-pack=x")
    ).rejects.toThrow(InvalidRequestError);
    s.git.currentBranch.mockResolvedValue(undefined);
    await expect(s.hub.bases.position(project.id, undefined)).rejects.toThrow(
      /detached HEAD/u
    );
    s.store.updateRuntime(project.id, { containerState: "stopped" });
    await expect(s.hub.bases.position(project.id, "main")).rejects.toThrow(
      UnavailableError
    );
  });

  it("pulls under the git lock even with the setting off, then reads the position again", async () => {
    const s = await started();
    s.preferences.mockReturnValue({ updateBaseBeforeTask: false });
    s.git.updateBase.mockImplementationOnce(state({ commits: 3, kind: "ff" }));
    s.git.updateBase.mockImplementation(state({ kind: "up-to-date" }));
    await expect(
      s.hub.bases.pull(project.id, "main", { branch: "fix" })
    ).resolves.toMatchObject({ behind: 0, update: { kind: "up-to-date" } });
    expect(s.git.updateBase.mock.calls.map((c) => c[3])).toStrictEqual([
      { dryRun: false },
      { dryRun: true },
    ]);
    expect(s.hub.environments.logLines(project.id)).toContain(
      "pull: fast-forwarded main to origin/main (3 commits)"
    );
  });
});
