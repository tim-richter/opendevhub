import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandError } from "../../src/server/containers";
import { type RunResult, spawnRunner } from "../../src/server/exec";
import type { ForgeEntry } from "../../src/server/forge";
import { parseRemote } from "../../src/server/forge";
import { detectForge, Publisher, probeForge } from "../../src/server/publish";
import type { Project } from "../../src/shared/types";

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

const project: Project = { id: "p", name: "p", path: "/p", devcontainerPath: "/p/x" };

describe("Publisher", () => {
  let tmp: string;
  let repo: string;
  let bare: string;
  let env: Record<string, string>;
  const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  const hostRuns: string[][] = [];
  const containerRuns: Array<{ cmd: string[]; env?: Record<string, string> }> = [];

  function publisher(over: { env?: NodeJS.ProcessEnv; forges?: Record<string, { kind: "forgejo" }> } = {}) {
    hostRuns.length = 0;
    containerRuns.length = 0;
    return new Publisher({
      run: (cmd, args, o) => {
        hostRuns.push([cmd, ...args]);
        return spawnRunner(cmd, args, { ...o, env: { ...env, ...o?.env } });
      },
      containers: {
        exec: (_p: Project, cmd: string[], o?: { env?: Record<string, string>; timeoutMs?: number }): Promise<RunResult> => {
          containerRuns.push({ cmd, env: o?.env });
          return spawnRunner(cmd[0], cmd.slice(1), { timeoutMs: o?.timeoutMs, env: { ...env, ...o?.env } });
        },
      },
      forges: { all: () => over.forges ?? {}, remember: () => {} },
      fetchImpl: async () => new Response("", { status: 404 }),
      env: over.env ?? {},
    });
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-publish-"));
    const home = path.join(tmp, "home");
    fs.mkdirSync(home);
    env = { HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1" };
    bare = path.join(tmp, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare], { env: { ...process.env, ...env } });
    git(bare, "config", "receive.advertisePushOptions", "true");
    fs.writeFileSync(
      path.join(bare, "hooks", "post-receive"),
      '#!/bin/sh\nwhile read old new ref; do echo "ref $ref"; done\ni=0\nwhile [ $i -lt "${GIT_PUSH_OPTION_COUNT:-0}" ]; do eval "echo option \\$GIT_PUSH_OPTION_$i"; i=$((i+1)); done\necho "Visit the pull request: https://forge.example.com/me/app/pulls/7"\n',
      { mode: 0o755 },
    );
    repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.name", "t");
    git(repo, "config", "user.email", "t@t");
    fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "-q", "origin", "main");
    git(repo, "checkout", "-q", "-b", "feature/x");
    fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "b");
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const checkout = () => ({ container: repo, host: repo });
  const req = { remote: "origin", base: "main", strategy: "branch" as const, title: "Add b", description: "Adds b." };

  it("pushes from the host when the checkout works there, else from the container, unless forced", async () => {
    expect(await publisher().location(project, checkout())).toEqual({ where: "host", dir: repo });
    expect(await publisher().location(project, { container: repo, host: path.join(tmp, "missing") })).toEqual({ where: "container", dir: repo });
    expect(await publisher().location(project, { container: repo })).toEqual({ where: "container", dir: repo });
    expect(await publisher({ env: { OPENDEVHUB_PUSH: "container" } }).location(project, checkout())).toEqual({ where: "container", dir: repo });
    await expect(publisher({ env: { OPENDEVHUB_PUSH: "host" } }).location(project, { container: repo })).rejects.toBeInstanceOf(CommandError);
  });

  it("describes the remotes, the forge and the stored PR", async () => {
    git(repo, "remote", "add", "fork", "git@github.com:me/app.git");
    git(repo, "config", "branch.feature/x.opendevhubPr", "https://forge.example.com/me/app/pulls/3");
    const info = await publisher().info(project, checkout(), "feature/x");
    expect(info).toEqual({
      branch: "feature/x",
      remotes: ["fork", "origin"],
      remote: "origin",
      forge: { kind: "unknown" },
      strategies: ["branch"],
      strategy: "branch",
      pushFrom: "host",
      pr: "https://forge.example.com/me/app/pulls/3",
    });
    expect((await publisher().info(project, checkout(), "feature/x", "fork")).forge).toEqual({ kind: "github", webBase: "https://github.com/me/app" });
  });

  it("pushes the branch with its upstream, records it, and stores the PR the remote printed", async () => {
    const result = await publisher().publish(project, checkout(), "feature/x", req);
    expect(git(bare, "rev-parse", "refs/heads/feature/x").trim()).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(git(repo, "rev-parse", "--abbrev-ref", "feature/x@{u}").trim()).toBe("origin/feature/x");
    expect(git(repo, "config", "branch.feature/x.opendevhubPublished").trim()).toBe("origin");
    expect(result).toMatchObject({ strategy: "branch", pushedFrom: "host", prUrl: "https://forge.example.com/me/app/pulls/7", openUrl: "https://forge.example.com/me/app/pulls/7" });
    expect(git(repo, "config", "branch.feature/x.opendevhubPr").trim()).toBe("https://forge.example.com/me/app/pulls/7");
    expect(hostRuns.some((r) => r.includes("push"))).toBe(true);
  });

  it("sends an AGit push with single-line options for Forgejo remotes", async () => {
    git(repo, "remote", "set-url", "origin", "ssh://git@git.example.com/me/app.git");
    git(repo, "config", "url." + bare + ".insteadOf", "ssh://git@git.example.com/me/app.git");
    const p = publisher({ forges: { "git.example.com": { kind: "forgejo" } } });
    const result = await p.publish(project, checkout(), "feature/x", { ...req, strategy: "agit", description: "Adds b.\nAnd more." });
    expect(result.output.join("\n")).toContain("ref refs/for/main");
    expect(result.output.join("\n")).toContain("option topic=feature/x");
    expect(result.output.join("\n")).toContain("option description=Adds b. And more.");
    expect(git(repo, "config", "branch.feature/x.opendevhubTopic").trim()).toBe("feature/x");
    await expect(publisher().publish(project, checkout(), "feature/x", { ...req, strategy: "agit" })).rejects.toThrow(/AGit/);
  });

  it("says when a stored PR was replaced by a new one", async () => {
    git(repo, "config", "branch.feature/x.opendevhubPr", "https://forge.example.com/me/app/pulls/3");
    const result = await publisher().publish(project, checkout(), "feature/x", req);
    expect(result.notice).toMatch(/closed or merged/);
  });

  it("explains a rejected push and never prompts for credentials", async () => {
    const other = path.join(tmp, "other");
    execFileSync("git", ["clone", "-q", bare, other], { env: { ...process.env, ...env } });
    git(other, "config", "user.name", "o");
    git(other, "config", "user.email", "o@o");
    git(other, "checkout", "-q", "-b", "feature/x");
    fs.writeFileSync(path.join(other, "c.txt"), "c\n");
    git(other, "add", "-A");
    git(other, "commit", "-q", "-m", "c");
    git(other, "push", "-q", "origin", "feature/x");
    const err = await publisher().publish(project, checkout(), "feature/x", req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as Error).message).toMatch(/Update from base/);

    await publisher({ env: { OPENDEVHUB_PUSH: "container" } }).publish(project, checkout(), "feature/x", { ...req, remote: "origin" }).catch(() => {});
    expect(containerRuns.find((r) => r.cmd.includes("push"))?.env).toMatchObject({ GIT_TERMINAL_PROMPT: "0" });
  });
});
