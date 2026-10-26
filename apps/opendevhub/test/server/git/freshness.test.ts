import { describe, expect, it, vi } from "vitest";

import {
  BaseFreshness,
  FETCH_MAX_AGE_MS,
} from "../../../src/server/git/freshness";
import type { ProjectRuntime } from "../../../src/shared/types";

const freshness = () => {
  let now = 1000;
  const runtimes = new Map<string, Partial<ProjectRuntime>>();
  const releases: (() => void)[] = [];
  const fetch = vi.fn(
    (_id: string, _remote: string) =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      })
  );
  const f = new BaseFreshness({
    fetch,
    now: () => now,
    store: {
      runtime: (id) => runtimes.get(id) ?? {},
      updateRuntime: (id, patch) =>
        runtimes.set(id, { ...runtimes.get(id), ...patch }),
    },
  });
  /** Lets every fetch started so far finish. */
  const finish = async () => {
    while (releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
    }
  };
  return {
    advance: (ms: number) => {
      now += ms;
    },
    f,
    fetch,
    finish,
    runtimes,
  };
};

describe(BaseFreshness, () => {
  it("fetches once, then answers from the last fetch until it is too old", async () => {
    const t = freshness();
    const first = t.f.ensureFresh("p", "origin");
    await t.finish();
    await expect(first).resolves.toBe(1000);
    t.advance(60_000);
    await expect(t.f.ensureFresh("p", "origin")).resolves.toBe(1000);
    expect(t.fetch).toHaveBeenCalledOnce();
    t.advance(FETCH_MAX_AGE_MS);
    const again = t.f.ensureFresh("p", "origin");
    await t.finish();
    await expect(again).resolves.toBe(1000 + 60_000 + FETCH_MAX_AGE_MS);
    expect(t.fetch).toHaveBeenCalledTimes(2);
  });

  it("fetches anyway when forced", async () => {
    const t = freshness();
    t.f.record("p", "origin");
    t.advance(30_000);
    const forced = t.f.ensureFresh("p", "origin", { force: true });
    await t.finish();
    await expect(forced).resolves.toBe(31_000);
    expect(t.fetch).toHaveBeenCalledOnce();
  });

  it("only counts a fetch of the same remote", async () => {
    const t = freshness();
    t.f.record("p", "fork");
    const read = t.f.ensureFresh("p", "origin");
    await t.finish();
    await read;
    expect(t.fetch).toHaveBeenCalledWith("p", "origin");
  });

  it("shares a fetch that is already running", async () => {
    const t = freshness();
    const a = t.f.ensureFresh("p", "origin");
    const b = t.f.ensureFresh("p", "origin", { force: true });
    await t.finish();
    await expect(Promise.all([a, b])).resolves.toStrictEqual([1000, 1000]);
    expect(t.fetch).toHaveBeenCalledOnce();
  });

  it("keeps the last good fetch when one fails, and passes the error on", async () => {
    const t = freshness();
    t.f.record("p", "origin");
    t.fetch.mockRejectedValueOnce(new Error("could not read from remote"));
    await expect(
      t.f.ensureFresh("p", "origin", { force: true })
    ).rejects.toThrow(/could not read/u);
    expect(t.f.lastFetchAt("p", "origin")).toBe(1000);
  });
});
