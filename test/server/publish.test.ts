import { describe, expect, it, vi } from "vitest";
import type { ForgeEntry } from "../../src/server/forge";
import { parseRemote } from "../../src/server/forge";
import { detectForge, probeForge } from "../../src/server/publish";

function memoryStore(initial: Record<string, ForgeEntry> = {}) {
  const forges = { ...initial };
  return { forges, all: () => forges, remember: vi.fn((host: string, e: ForgeEntry) => void (forges[host] = e)) };
}

const respond = (routes: Record<string, unknown>) =>
  vi.fn(async (url: string | URL | Request) => {
    const body = routes[String(url)];
    return body === undefined ? new Response("nope", { status: 404 }) : new Response(JSON.stringify(body), { status: 200 });
  });

describe("probeForge", () => {
  it("recognises Forgejo first, then Gitea", async () => {
    expect(await probeForge("https://git.example.com", respond({ "https://git.example.com/api/forgejo/v1/version": { version: "11.0" } }))).toBe("forgejo");
    expect(await probeForge("https://g.example.com", respond({ "https://g.example.com/api/v1/version": { version: "1.22" } }))).toBe("gitea");
    expect(await probeForge("https://x.example.com", respond({}))).toBe("unknown");
  });

  it("gives up on hosts that don't answer", async () => {
    const hang = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))),
    );
    vi.useFakeTimers();
    try {
      const result = probeForge("https://slow.example.com", hang);
      await vi.advanceTimersByTimeAsync(7000);
      expect(await result).toBe("unknown");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("detectForge", () => {
  it("uses known forges without probing", async () => {
    const fetchImpl = respond({});
    expect(await detectForge(parseRemote("git@github.com:a/b.git"), memoryStore(), fetchImpl)).toEqual({ kind: "github", webBase: "https://github.com/a/b" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("probes an unknown host once and remembers the answer, unknown included", async () => {
    const store = memoryStore();
    const fetchImpl = respond({ "https://git.example.com/api/forgejo/v1/version": { version: "11" } });
    expect(await detectForge(parseRemote("git@git.example.com:t/a.git"), store, fetchImpl)).toEqual({
      kind: "forgejo",
      webBase: "https://git.example.com/t/a",
    });
    expect(store.remember).toHaveBeenCalledWith("git.example.com", { kind: "forgejo" });
    await detectForge(parseRemote("git@git.example.com:t/a.git"), store, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const none = respond({});
    await detectForge(parseRemote("git@plain.example.com:t/a.git"), store, none);
    await detectForge(parseRemote("git@plain.example.com:t/a.git"), store, none);
    expect(store.forges["plain.example.com"]).toEqual({ kind: "unknown" });
    expect(none).toHaveBeenCalledTimes(2); // two endpoints on the first detect, none on the second
  });

  it("never probes ssh aliases or local remotes", async () => {
    const fetchImpl = respond({});
    expect(await detectForge(parseRemote("gh:a/b"), memoryStore(), fetchImpl)).toEqual({ kind: "unknown" });
    expect(await detectForge(undefined, memoryStore(), fetchImpl)).toEqual({ kind: "unknown" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
