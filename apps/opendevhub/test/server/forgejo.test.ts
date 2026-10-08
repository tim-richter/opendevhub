import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  countApprovals,
  FileForgejoSettings,
  Forgejo,
  forgejoUrl,
} from "../../src/server/forgejo";
import { CredentialStoreError } from "../../src/server/secrets";
import { MemorySecretStore } from "../helpers/secrets";

let dir: string;
let settings: FileForgejoSettings;
let secrets: MemorySecretStore;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-forgejo-settings-"));
  secrets = new MemorySecretStore();
  settings = new FileForgejoSettings(dir, secrets);
});
afterEach(() => fs.rmSync(dir, { force: true, recursive: true }));
const configured = {
  enabled: true,
  url: "https://forge.example.com/git",
  token: "test-secret",
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const issue = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  updated_at: `2026-10-0${number}T12:00:00Z`,
  state: "open",
  user: { login: "alice" },
  repository: { full_name: "team/private" },
  pull_request: {},
  ...extra,
});

describe("protected Forgejo settings", () => {
  it("is opt-in, survives restart and exposes only the token's presence", async () => {
    await expect(settings.view()).resolves.toStrictEqual({
      enabled: false,
      url: "",
      hasToken: false,
    });
    await expect(settings.save(configured)).resolves.toStrictEqual({
      enabled: true,
      url: configured.url,
      hasToken: true,
    });
    await expect(
      new FileForgejoSettings(dir, secrets).view()
    ).resolves.toStrictEqual(await settings.view());
    expect(fs.statSync(path.join(dir, "integrations")).mode & 0o777).toBe(
      0o700
    );
    expect(
      fs.statSync(path.join(dir, "integrations/forgejo.json")).mode & 0o777
    ).toBe(0o600);
    expect(fs.existsSync(path.join(dir, "config.json"))).toBeFalsy();
    expect(
      fs.readFileSync(path.join(dir, "integrations/forgejo.json"), "utf-8")
    ).not.toContain(configured.token);
    expect([...secrets.values.values()]).toStrictEqual([configured.token]);
    expect(JSON.stringify(await settings.view())).not.toContain(
      configured.token
    );
    expect(fs.readdirSync(path.join(dir, "integrations"))).toStrictEqual([
      "forgejo.json",
    ]);
  });

  it("keeps tokens when disabling, replaces them explicitly, and forgets them on removal", async () => {
    await settings.save(configured);
    await settings.save({ enabled: false, url: configured.url });
    expect((await settings.read()).token).toBe(configured.token);
    await settings.save({ ...configured, token: "new-token" });
    expect([...secrets.values.values()]).toStrictEqual(["new-token"]);
    expect((await settings.read()).token).toBe("new-token");
    await settings.save({
      enabled: false,
      url: configured.url,
      clearToken: true,
    });
    expect((await settings.view()).hasToken).toBeFalsy();
    expect(secrets.values.size).toBe(0);
    expect(
      fs.readFileSync(path.join(dir, "integrations/forgejo.json"), "utf-8")
    ).not.toContain("new-token");
  });

  it("never reuses a token when the instance or path changes", async () => {
    await settings.save(configured);
    await expect(
      settings.save({ enabled: true, url: "https://other.example.com" })
    ).rejects.toThrow("URL and token");
    expect((await settings.read()).url).toBe(configured.url);
    await settings.save({ enabled: false, url: `${configured.url}/other` });
    expect((await settings.view()).hasToken).toBeFalsy();
  });

  it("validates input and keeps errors free of credentials", async () => {
    for (const value of [
      "http://forge.example.com",
      "file:///tmp/test",
      "https://alice:secret@example.com",
      "https://example.com?token=secret",
      "https://example.com#secret",
    ]) {
      expect(() => forgejoUrl(value)).toThrow();
    }
    expect(forgejoUrl(" http://127.0.0.1:3000/ ")).toBe(
      "http://127.0.0.1:3000"
    );
    expect(forgejoUrl("http://[::1]:3000/")).toBe("http://[::1]:3000");
    await expect(
      settings.save({ ...configured, enabled: "yes" })
    ).rejects.toThrow("Invalid");
    await expect(
      settings.save({ ...configured, token: "test\nsecret" })
    ).rejects.toThrow("Invalid");
    await expect(
      settings.save({ ...configured, clearToken: true })
    ).rejects.toThrow("Choose");
    await expect(settings.save({ enabled: true, url: "" })).rejects.toThrow(
      "required"
    );
  });

  it("repairs permissions and allows replacing corrupt settings without a secret backup", async () => {
    await settings.save(configured);
    const file = path.join(dir, "integrations/forgejo.json");
    fs.chmodSync(file, 0o644);
    fs.chmodSync(path.dirname(file), 0o755);
    await settings.view();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    fs.writeFileSync(file, "test-secret-not-json");
    await expect(settings.view()).rejects.toThrow(
      "Saved Forgejo settings are invalid"
    );
    await settings.save(configured);
    expect(fs.readdirSync(path.dirname(file))).toStrictEqual(["forgejo.json"]);
  });

  it("migrates legacy plaintext once before use, even with concurrent requests", async () => {
    const file = path.join(dir, "integrations/forgejo.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(configured));
    const set = vi.spyOn(secrets, "set");
    const [view, read] = await Promise.all([settings.view(), settings.read()]);
    expect(view).toStrictEqual({
      enabled: true,
      url: configured.url,
      hasToken: true,
    });
    expect(read.token).toBe(configured.token);
    expect(set).toHaveBeenCalledOnce();
    const saved = JSON.parse(fs.readFileSync(file, "utf-8"));
    expect(saved.token).toBeUndefined();
    expect(saved.tokenRef).toMatch(/^[0-9a-f-]{36}$/u);
    expect(fs.readFileSync(file, "utf-8")).not.toContain(configured.token);
    expect(fs.readdirSync(path.dirname(file))).toStrictEqual(["forgejo.json"]);
    expect((await new FileForgejoSettings(dir, secrets).read()).token).toBe(
      configured.token
    );
  });

  it("fails closed if migration is blocked, and lets the user discard a legacy token", async () => {
    const file = path.join(dir, "integrations/forgejo.json");
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(configured));
    vi.spyOn(secrets, "set").mockRejectedValue(new CredentialStoreError());
    const fetcher = vi.fn();
    await expect(new Forgejo(settings, fetcher).pulls()).rejects.toThrow(
      "OS credential store"
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toStrictEqual(
      configured
    );
    expect(fs.readdirSync(path.dirname(file))).toStrictEqual(["forgejo.json"]);
    await settings.save({
      enabled: false,
      url: configured.url,
      clearToken: true,
    });
    expect(fs.readFileSync(file, "utf-8")).not.toContain(configured.token);
  });

  it("never falls back to plaintext when credential storage fails", async () => {
    vi.spyOn(secrets, "set").mockRejectedValue(new CredentialStoreError());
    await expect(settings.save(configured)).rejects.toThrow(
      "OS credential store"
    );
    expect(fs.existsSync(path.join(dir, "integrations/forgejo.json"))).toBe(
      false
    );
  });

  it("still clears or replaces a token when the old credential cannot be deleted", async () => {
    await settings.save(configured);
    const [oldRef] = [...secrets.values.keys()];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(secrets, "get").mockRejectedValue(new CredentialStoreError());
    vi.spyOn(secrets, "remove").mockRejectedValue(
      new CredentialStoreError("denied")
    );
    await expect(
      settings.save({ ...configured, token: "replacement" })
    ).resolves.toMatchObject({ hasToken: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(oldRef));
    await expect(
      settings.save({ enabled: false, url: configured.url, clearToken: true })
    ).resolves.toMatchObject({ hasToken: false });
    expect(
      fs.readFileSync(path.join(dir, "integrations/forgejo.json"), "utf-8")
    ).not.toContain("tokenRef");
    warn.mockRestore();
  });

  it("restores the previous credential if the settings file cannot be committed", async () => {
    await settings.save(configured);
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      throw new Error("write failed");
    });
    try {
      await expect(
        settings.save({ ...configured, token: "replacement" })
      ).rejects.toThrow("Could not save Forgejo settings");
      expect((await settings.read()).token).toBe(configured.token);
      expect([...secrets.values.values()]).toStrictEqual([configured.token]);
    } finally {
      rename.mockRestore();
    }
  });

  it("does not access the credential store for disabled integrations", async () => {
    await settings.save(configured);
    await settings.save({ enabled: false, url: configured.url });
    const get = vi
      .spyOn(secrets, "get")
      .mockRejectedValue(new CredentialStoreError());
    expect((await settings.view()).hasToken).toBeTruthy();
    await expect(new Forgejo(settings, vi.fn()).pulls()).rejects.toMatchObject({
      status: 412,
    });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("Forgejo API client", () => {
  it("makes no upstream requests when disabled", async () => {
    const fetcher = vi.fn();
    const forgejo = new Forgejo(settings, fetcher);
    await expect(forgejo.pulls()).rejects.toMatchObject({ status: 412 });
    await expect(forgejo.diff("team", "private", "1")).rejects.toMatchObject({
      status: 412,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("loads all pages, filters by author and state, deduplicates and handles private repository metadata", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ login: "alice" }))
      .mockResolvedValueOnce(
        response([
          issue(1),
          issue(2, { user: { login: "bob" } }),
          issue(3, { state: "closed" }),
          issue(4, { pull_request: null }),
        ])
      )
      .mockResolvedValueOnce(response([issue(5), issue(1)]))
      .mockResolvedValueOnce(response([]));
    const result = await new Forgejo(settings, fetcher).pulls("open");
    expect(result.username).toBe("alice");
    expect(result.pulls.map((p) => p.number)).toStrictEqual([5, 1]);
    expect(result.pulls[0].url).toBe(`${configured.url}/team/private/pulls/5`);
    expect(fetcher.mock.calls[0][0]).toBe(`${configured.url}/api/v1/user`);
    const search = new URL(String(fetcher.mock.calls[1][0]));
    expect(Object.fromEntries(search.searchParams)).toMatchObject({
      type: "pulls",
      state: "open",
      created: "true",
      page: "1",
    });
    expect(String(fetcher.mock.calls[2][0])).toContain("page=2");
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.headers).toMatchObject({
        authorization: "token test-secret",
      });
      expect(init?.redirect).toBe("error");
      expect(init?.method).toBeUndefined();
    }
    expect(JSON.stringify(result)).not.toContain("test-secret");
  });

  it("defaults to open authored PRs", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ login: "alice" }))
      .mockResolvedValueOnce(
        response([
          issue(1),
          issue(2, { state: "closed" }),
          issue(3, { state: "closed", pull_request: { merged: true } }),
          issue(4, { user: { login: "bob" } }),
        ])
      )
      .mockResolvedValueOnce(response([]));
    const result = await new Forgejo(settings, fetcher).pulls();
    expect(result.pulls.map((p) => [p.number, p.state])).toStrictEqual([
      [1, "open"],
    ]);
    expect(String(fetcher.mock.calls[1][0])).toContain("state=open");
    await expect(
      new Forgejo(settings, fetcher).pulls("invalid")
    ).rejects.toMatchObject({ status: 400 });
  });

  it("lists open review candidates across authors without the created filter", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ login: "alice" }))
      .mockResolvedValueOnce(
        response([
          issue(1),
          issue(2, { user: { login: "bob" } }),
          issue(3, { state: "closed" }),
        ])
      )
      .mockResolvedValueOnce(response([]));
    const result = await new Forgejo(settings, fetcher).pulls("all", "review");
    expect(result.pulls.map((p) => p.number)).toStrictEqual([2, 1]);
    const query = new URL(String(fetcher.mock.calls[1][0])).searchParams;
    expect(query.get("created")).toBeNull();
    expect(query.get("state")).toBe("open");
  });

  it("counts each reviewer's latest official, undismissed vote", () => {
    const review = (
      id: number,
      author: string,
      state: string,
      extra: Record<string, unknown> = {}
    ) => ({
      author,
      body: "",
      commentsCount: 0,
      commit: "c",
      dismissed: false,
      id,
      stale: false,
      state,
      submittedAt: "now",
      ...extra,
    });
    expect(
      countApprovals([
        review(5, "bob", "APPROVED"),
        review(1, "bob", "REQUEST_CHANGES"),
        review(2, "carol", "APPROVED"),
        review(6, "carol", "COMMENT"),
        review(3, "dave", "REQUEST_CHANGES"),
        review(7, "erin", "APPROVED", { dismissed: true }),
        review(8, "frank", "APPROVED", { official: false }),
        review(4, "gina", "APPROVED"),
        review(9, "gina", "REQUEST_CHANGES", { dismissed: true }),
      ])
    ).toStrictEqual({
      approvedBy: ["bob", "carol"],
      changesRequestedBy: ["dave"],
    });
  });

  it("reads required approvals from the base branch's protection", async () => {
    await settings.save(configured);
    const details = {
      number: 1,
      title: "Change",
      updated_at: "now",
      state: "open",
      base: { ref: "release/1.0" },
      head: { ref: "feature", sha: "a".repeat(40) },
    };
    const reviews = [
      {
        id: 1,
        user: { login: "bob" },
        body: "",
        state: "APPROVED",
        submitted_at: "now",
        commit_id: "a",
        dismissed: false,
        stale: false,
        comments_count: 0,
        official: true,
      },
    ];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(details))
      .mockResolvedValueOnce(
        response({ protected: true, required_approvals: 2 })
      )
      .mockResolvedValueOnce(response(reviews));
    await expect(
      new Forgejo(settings, fetcher).approvals("team", "private", "1")
    ).resolves.toStrictEqual({
      approvedBy: ["bob"],
      base: "release/1.0",
      changesRequestedBy: [],
      required: 2,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1][0]).toBe(
      `${configured.url}/api/v1/repos/team/private/branches/release/1.0`
    );
    fetcher
      .mockReset()
      .mockResolvedValueOnce(response(details))
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(response([]));
    await expect(
      new Forgejo(settings, fetcher).approvals("team", "private", "1")
    ).resolves.toStrictEqual({
      approvedBy: [],
      base: "release/1.0",
      changesRequestedBy: [],
      required: undefined,
    });
  });

  it("reuses a branch's required approvals across pull requests for a while", async () => {
    await settings.save(configured);
    const details = (number: number) => ({
      number,
      title: "Change",
      updated_at: "now",
      state: "open",
      base: { ref: "main" },
      head: { ref: `feature-${number}`, sha: "a".repeat(40) },
    });
    const branchRoute = `${configured.url}/api/v1/repos/team/private/branches/main`;
    let protection = () => response({ protected: true, required_approvals: 2 });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === branchRoute) {
        return protection();
      }
      if (url.includes("/reviews?")) {
        return response([]);
      }
      return response(details(Number(url.split("/").pop())));
    });
    let time = 0;
    const forgejo = new Forgejo(settings, fetcher, () => time);
    const branchCalls = () =>
      fetcher.mock.calls.filter(([url]) => String(url) === branchRoute).length;
    const [one, two] = await Promise.all([
      forgejo.approvals("team", "private", "1"),
      forgejo.approvals("team", "private", "2"),
    ]);
    expect([one.required, two.required]).toStrictEqual([2, 2]);
    expect(branchCalls()).toBe(1);
    time = 4 * 60_000;
    await forgejo.approvals("team", "private", "3");
    expect(branchCalls()).toBe(1);
    time = 6 * 60_000;
    protection = () => new Response("", { status: 500 });
    await expect(forgejo.approvals("team", "private", "3")).rejects.toThrow(
      "Forgejo request failed (500)."
    );
    protection = () => response({ protected: true, required_approvals: 3 });
    await expect(
      forgejo.approvals("team", "private", "3")
    ).resolves.toMatchObject({ required: 3 });
    expect(branchCalls()).toBe(3);
  });

  it("submits inline comments on the loaded commit and refuses stale reviews", async () => {
    await settings.save(configured);
    const sha = "a".repeat(40);
    const details = {
      number: 1,
      title: "Change",
      updated_at: "now",
      state: "open",
      base: { ref: "main" },
      head: { ref: "feature", sha },
    };
    const input = {
      commitId: sha,
      body: "Summary",
      event: "COMMENT",
      comments: [
        { path: "a.txt", body: "Fix this", old_position: 0, new_position: 1 },
      ],
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(details))
      .mockResolvedValueOnce(new Response("patch"))
      .mockResolvedValueOnce(response({ id: 4 }));
    await expect(
      new Forgejo(settings, fetcher).review("team", "private", "1", input)
    ).resolves.toStrictEqual({ sent: true });
    expect(fetcher.mock.calls[2][0]).toBe(
      `${configured.url}/api/v1/repos/team/private/pulls/1/reviews`
    );
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toStrictEqual({
      commit_id: sha,
      body: input.body,
      event: input.event,
      comments: input.comments,
    });
    expect(fetcher.mock.calls[2][1]).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    fetcher
      .mockReset()
      .mockResolvedValueOnce(
        response({ ...details, head: { ref: "feature", sha: "b".repeat(40) } })
      )
      .mockResolvedValueOnce(new Response("patch"));
    await expect(
      new Forgejo(settings, fetcher).review("team", "private", "1", input)
    ).rejects.toThrow("PR changed");
    expect(fetcher).toHaveBeenCalledTimes(2);
    fetcher.mockReset();
    await expect(
      new Forgejo(settings, fetcher).review("team", "private", "1", {
        ...input,
        comments: [{ ...input.comments[0], new_position: -1 }],
      })
    ).rejects.toThrow("Invalid review comment");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("gets the diff from a constructed API path, never the upstream diff URL", async () => {
    await settings.save(configured);
    const patch =
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          number: 7,
          title: "Change",
          updated_at: "now",
          head: { ref: "feature" },
          base: { ref: "main" },
          diff_url: "https://attacker.example.com",
        })
      )
      .mockResolvedValueOnce(new Response(patch));
    const diff = await new Forgejo(settings, fetcher).diff(
      "team",
      "private",
      "7"
    );
    expect(diff).toMatchObject({ head: "feature", base: "main", patch });
    expect(fetcher.mock.calls[1][0]).toBe(
      `${configured.url}/api/v1/repos/team/private/pulls/7.diff`
    );
  });

  it("rejects invalid repository paths and numbers before sending a token", async () => {
    await settings.save(configured);
    const fetcher = vi.fn();
    const forgejo = new Forgejo(settings, fetcher);
    for (const [owner, repo, number] of [
      ["..", "repo", "1"],
      ["team", "x/y", "1"],
      ["team", "repo", "1.diff?x=y"],
      ["team", "repo", "0"],
    ]) {
      await expect(forgejo.diff(owner, repo, number)).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not echo upstream errors, redirect errors, or authentication details", async () => {
    await settings.save(configured);
    for (const status of [401, 403, 404, 429, 500]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("test-secret upstream details", { status })
        );
      const err = await new Forgejo(settings, fetcher)
        .pulls()
        .catch((error: Error) => error);
      expect(err).toBeInstanceOf(Error);
      expect(JSON.stringify(err)).not.toContain("test-secret");
      expect((err as Error).message).not.toContain("upstream details");
    }
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("test-secret redirect blocked"));
    await expect(new Forgejo(settings, fetcher).pulls()).rejects.toThrow(
      "Could not reach Forgejo"
    );
  });

  it("reports malformed API responses and oversized diffs", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("<html>not JSON</html>"));
    await expect(new Forgejo(settings, fetcher).pulls()).rejects.toThrow(
      "invalid API response"
    );
    fetcher
      .mockReset()
      .mockResolvedValueOnce(response({ login: "alice" }))
      .mockResolvedValueOnce(response({ issues: [] }));
    await expect(new Forgejo(settings, fetcher).pulls()).rejects.toThrow(
      "invalid pull request list"
    );
    fetcher
      .mockReset()
      .mockResolvedValueOnce(
        response({
          number: 1,
          title: "Large",
          updated_at: "now",
          base: { ref: "main" },
          head: { ref: "feature" },
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array(20 * 1024 * 1024 + 1))
      );
    await expect(
      new Forgejo(settings, fetcher).diff("team", "private", "1")
    ).rejects.toThrow("20 MiB");
  });
});

describe("Forgejo inbox, context and connection verification", () => {
  it("returns a page promptly and uses review and assignment filters without filtering other authors", async () => {
    await settings.save(configured);
    for (const [inbox, filter] of [
      ["review-requested", "review_requested"],
      ["assigned", "assigned"],
    ] as const) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(response({ login: "alice" }))
        .mockResolvedValueOnce(response([issue(9, { user: { login: "bob" } })]))
        .mockResolvedValueOnce(response([]));
      const result = await new Forgejo(settings, fetcher).inbox({
        inbox,
        state: "open",
        page: 3,
        q: "fix CI",
      });
      expect(result.pulls[0].number).toBe(9);
      expect(result.nextPage).toBe(4);
      expect(fetcher).toHaveBeenCalledTimes(3);
      const query = new URL(String(fetcher.mock.calls[1][0])).searchParams;
      expect(query.get(filter)).toBe("true");
      expect(query.get("created")).toBeNull();
      expect(query.get("q")).toBe("fix CI");
    }
  });

  it("links stacked pull requests with one listing per repository and ignores listing failures", async () => {
    await settings.save(configured);
    const open = (
      number: number,
      base: string,
      head: string,
      headRepo = 1
    ) => ({
      number,
      title: `PR ${number}`,
      base: { ref: base, repo_id: 1, repo: { default_branch: "main" } },
      head: { ref: head, repo_id: headRepo },
    });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/user")) {
        return response({ login: "alice" });
      }
      if (url.includes("issues/search")) {
        return response([
          issue(1),
          issue(2),
          issue(3),
          issue(4),
          issue(5, { state: "closed" }),
          issue(6, { repository: { full_name: "team/broken" } }),
        ]);
      }
      if (url.includes("team/broken")) {
        return response("private error", 500);
      }
      return response([
        open(1, "main", "feat/a"),
        open(2, "feat/a", "feat/b"),
        open(3, "release/1", "fix/backport"),
        open(4, "feat/fork", "x"),
        open(7, "main", "feat/fork", 99),
      ]);
    });
    let time = 0;
    const forgejo = new Forgejo(settings, fetcher, () => time);
    const { pulls } = await forgejo.inbox({ state: "all" });
    const stacks = Object.fromEntries(pulls.map((p) => [p.number, p.stack]));
    expect(stacks).toEqual({
      1: undefined,
      2: { base: "feat/a", parent: { number: 1, title: "PR 1" } },
      3: { base: "release/1" },
      // A fork's branch of the same name is not this repository's branch.
      4: { base: "feat/fork" },
      5: undefined,
      6: undefined,
    });
    const listings = (repo: string) =>
      fetcher.mock.calls
        .map(([url]) => String(url))
        .filter((url) => url.includes(`repos/${repo}/pulls?state=open`));
    expect(listings("team/private")).toHaveLength(1);
    expect(listings("team/broken")).toHaveLength(1);
    // Listings are reused briefly; failed ones are retried on the next load.
    time = 30_000;
    const again = await forgejo.inbox({ state: "all" });
    expect(again.pulls[1].stack?.parent?.number).toBe(1);
    expect(listings("team/private")).toHaveLength(1);
    expect(listings("team/broken")).toHaveLength(2);
    time = 61_000;
    await forgejo.inbox({ state: "all" });
    expect(listings("team/private")).toHaveLength(2);
  });

  it("shows a pull request's stack below and above it, without a fork's same-named branches", async () => {
    await settings.save(configured);
    const open = (
      number: number,
      base: string,
      head: string,
      headRepo = 1
    ) => ({
      number,
      title: `PR ${number}`,
      base: { ref: base, repo_id: 1 },
      head: { ref: head, repo_id: headRepo },
    });
    let listing = () =>
      response([
        open(1, "main", "feat/a"),
        open(2, "feat/a", "feat/b"),
        open(3, "feat/b", "feat/c"),
        open(4, "feat/c", "feat/d"),
        open(5, "feat/b", "feat/e"),
        open(6, "feat/a", "feat/sibling"),
        open(8, "feat/b", "feat/f", 99),
        open(9, "feat/f", "feat/g"),
      ]);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/pulls?")) {
        return listing();
      }
      const number = Number(url.split("/").pop());
      return response({
        number,
        title: `PR ${number}`,
        updated_at: "now",
        state: "open",
        base: { ref: number === 2 ? "feat/a" : "feat/b" },
        head: {
          ref: number === 2 ? "feat/b" : "feat/f",
          sha: "a".repeat(40),
          repo: { full_name: number === 2 ? "team/private" : "fork/private" },
        },
      });
    });
    let time = 0;
    const forgejo = new Forgejo(settings, fetcher, () => time);
    const pr = (number: number, children: unknown[] = []) => ({
      number,
      title: `PR ${number}`,
      children,
    });
    const { stack } = await forgejo.details("team", "private", "2");
    expect(stack).toMatchObject({
      ancestors: [{ number: 1, base: "main", head: "feat/a" }],
      descendants: [pr(3, [pr(4)]), pr(5), pr(8)],
    });
    // A fork's head branch can't be the base of anything here, even with a matching name.
    const fork = await forgejo.details("team", "private", "7");
    expect(fork.stack?.descendants).toEqual([]);
    expect(fork.stack?.ancestors.map((p) => p.number)).toEqual([1, 2]);
    time = 61_000;
    listing = () => response("private error", 500);
    const failed = await forgejo.details("team", "private", "2");
    expect(failed.stack).toBeUndefined();
    expect(failed.head).toBe("feat/b");
  });

  it("lists a repository's open pull requests anew after the settings change", async () => {
    await settings.save(configured);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/user")) {
        return response({ login: "alice" });
      }
      return response(url.includes("issues/search") ? [issue(1)] : []);
    });
    const forgejo = new Forgejo(settings, fetcher, () => 0);
    await forgejo.inbox();
    await forgejo.save(configured);
    await forgejo.inbox();
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes("/pulls?"))
    ).toHaveLength(2);
  });

  it("filters repositories exactly and continues despite an empty filtered page", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ login: "alice" }))
      .mockResolvedValueOnce(response({ id: 17 }))
      .mockResolvedValueOnce(
        response([issue(1, { repository: { full_name: "team/other" } })])
      );
    await expect(
      new Forgejo(settings, fetcher).inbox({ repository: "team/private" })
    ).resolves.toMatchObject({ pulls: [], nextPage: 2 });
    expect(String(fetcher.mock.calls[2][0])).toContain("priority_repo_id=17");
    for (const input of [
      { page: 0 },
      { page: 201 },
      { inbox: "other" },
      { repository: "../private" },
      { repository: "team/private/extra" },
    ]) {
      await expect(
        new Forgejo(settings, fetcher).inbox(input as never)
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("loads metadata independently of an oversized patch", async () => {
    await settings.save(configured);
    const sha = "a".repeat(40);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          number: 7,
          title: "Fix",
          updated_at: "now",
          body: "Reason",
          user: { login: "bob" },
          draft: true,
          mergeable: false,
          head: {
            ref: "refs/pull/7/head",
            sha,
            repo: { full_name: "fork/private" },
          },
          base: { ref: "main" },
          labels: [{ name: "bug" }],
          requested_reviewers: [{ login: "alice" }],
        })
      )
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(20 * 1024 * 1024 + 1))
      );
    const forgejo = new Forgejo(settings, fetcher);
    await expect(
      forgejo.details("team", "private", "7")
    ).resolves.toMatchObject({
      body: "Reason",
      author: "bob",
      headSha: sha,
      draft: true,
      mergeable: false,
      labels: ["bug"],
      reviewers: ["alice"],
      headRepository: "fork/private",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(forgejo.patch("team", "private", "7")).rejects.toThrow(
      "20 MiB"
    );
  });

  it("normalizes comments, reviews, inline discussion and checks, rejecting unsafe links", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response([
          { id: 1, body: "Fix", user: { login: "bob" }, updated_at: "now" },
        ])
      )
      .mockResolvedValueOnce(
        response([
          {
            id: 2,
            body: "Changes needed",
            state: "REQUEST_CHANGES",
            user: { login: "bob" },
            commit_id: "a".repeat(40),
            comments_count: 1,
            stale: true,
          },
        ])
      )
      .mockResolvedValueOnce(
        response([
          {
            id: 3,
            body: "Line feedback",
            path: "a.ts",
            position: 4,
            original_position: 0,
            diff_hunk: "@@ -1 +1 @@\n+x",
            resolver: { login: "bob" },
          },
        ])
      )
      .mockResolvedValueOnce(
        response({
          sha: "a".repeat(40),
          state: "failure",
          total_count: 2,
          statuses: [
            {
              id: 4,
              context: "tests",
              status: "failure",
              description: "2 tests failed",
              target_url: "javascript:alert(1)",
            },
            {
              id: 5,
              context: "lint",
              status: "success",
              target_url: "https://ci.example/job/5",
            },
          ],
        })
      );
    const forgejo = new Forgejo(settings, fetcher);
    await expect(
      forgejo.comments("team", "private", "7", 2)
    ).resolves.toMatchObject({
      items: [{ id: 1, author: "bob", body: "Fix" }],
      nextPage: 3,
    });
    await expect(
      forgejo.reviews("team", "private", "7")
    ).resolves.toMatchObject({
      items: [
        { id: 2, state: "REQUEST_CHANGES", stale: true, commentsCount: 1 },
      ],
    });
    await expect(
      forgejo.reviewComments("team", "private", "7", "2")
    ).resolves.toMatchObject([
      { id: 3, path: "a.ts", line: 4, resolved: true },
    ]);
    const checks = await forgejo.checks("team", "private", "a".repeat(40));
    expect(checks.items[0].url).toBeUndefined();
    expect(checks.items[1].url).toBe("https://ci.example/job/5");
    expect(checks.nextPage).toBeUndefined();
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "/issues/7/comments?page=2"
    );
    await expect(
      forgejo.reviewComments("team", "private", "7", "1/else")
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      forgejo.checks("team", "private", "main?token=bad")
    ).rejects.toMatchObject({ status: 400 });
  });

  it("tests unsaved credentials without storing them or reusing a token on another instance", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ login: "bob" }))
      .mockResolvedValueOnce(response({ version: "11" }))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]));
    const forgejo = new Forgejo(settings, fetcher);
    await expect(
      forgejo.test({ url: "https://other.example", token: "unsaved-token" })
    ).resolves.toStrictEqual({ username: "bob", version: "11" });
    expect((await settings.read()).token).toBe(configured.token);
    expect([...secrets.values.values()]).toStrictEqual([configured.token]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.headers).toMatchObject({
        authorization: "token unsaved-token",
      });
    }
    await expect(
      forgejo.test({ url: "https://other.example" })
    ).rejects.toThrow("Enter a token");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("reuses the saved token only on the same instance, even while disabled", async () => {
    await settings.save(configured);
    await settings.save({ enabled: false, url: configured.url });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ login: "alice" }))
      .mockResolvedValueOnce(response({ version: "11" }))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]));
    await new Forgejo(settings, fetcher).test({ url: configured.url });
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({
      authorization: `token ${configured.token}`,
    });
    expect((await settings.view()).enabled).toBeFalsy();
  });

  it("propagates cancellation upstream and makes rate limits actionable", async () => {
    await settings.save(configured);
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        controller.abort();
        expect(init?.signal?.aborted).toBeTruthy();
        throw new Error("private error");
      });
    await expect(
      new Forgejo(settings, fetcher).patch(
        "team",
        "private",
        "1",
        controller.signal
      )
    ).rejects.toThrow("cancelled");
    const limited = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private error", { status: 429 }));
    await expect(new Forgejo(settings, limited).inbox()).rejects.toThrow(
      "request limit"
    );
  });
});
