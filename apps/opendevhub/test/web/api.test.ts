import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchJiraSettings,
  saveJiraSettings,
  fetchJiraTickets,
  fetchJiraTicket,
  commitChanges,
  createEnv,
  createTask,
  envAction,
  fetchCheckRun,
  fetchForgejoSettings,
  saveForgejoSettings,
  fetchForgejoPulls,
  fetchForgejoDiff,
  fetchForgejoDetails,
  fetchForgejoComments,
  fetchForgejoReviews,
  fetchForgejoReviewComments,
  fetchForgejoChecks,
  testForgejoConnection,
  fetchChecks,
  dismissForm,
  fetchModels,
  fetchPublishInfo,
  fetchReview,
  mergeIntoBase,
  pickVariant,
  publishChanges,
  removeEnv,
  removeSession,
  removeWorktree,
  runChecks,
  saveChecks,
  replyForm,
  replyPermission,
  sendPrompt,
  startSession,
  suggestCommitMessage,
  suggestPublish,
  updateFromBase,
} from "../../src/web/api";

const stubFetch = (status: number, body: unknown) => {
  const fetchMock = vi.fn<
    (url: string, init?: RequestInit) => Promise<Response>
  >((_url: string, _init?: RequestInit) =>
    Promise.resolve(Response.json(body, { status }))
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

describe("api", () => {
  afterEach(() => vi.unstubAllGlobals());

  describe("Jira API", () => {
    it("keeps saved tokens server-side and supports cancellable search and ticket requests", async () => {
      const fetchMock = stubFetch(200, {
        enabled: true,
        url: "https://jira.example.com",
        hasToken: true,
      });
      const response = await fetchJiraSettings();
      expect(response.hasToken).toBeTruthy();
      expect(fetchMock.mock.calls[0][0]).toBe("/api/jira/settings");
      await saveJiraSettings({
        enabled: false,
        url: "https://jira.example.com",
      });
      expect(
        JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
      ).not.toHaveProperty("token");
      const { signal } = new AbortController();
      await fetchJiraTickets(
        { search: "login & logout", startAt: 50, scope: "board", board: 3 },
        signal
      );
      expect(fetchMock.mock.calls[2]).toStrictEqual([
        "/api/jira/tickets?scope=board&board=3&search=login+%26+logout&startAt=50",
        {
          signal,
          cache: "no-store",
          method: "GET",
          body: undefined,
          headers: new Headers(),
        },
      ]);
      await fetchJiraTicket("APP-1?", signal);
      expect(fetchMock.mock.calls[3]).toStrictEqual([
        "/api/jira/tickets/APP-1%3F",
        {
          signal,
          cache: "no-store",
          method: "GET",
          body: undefined,
          headers: new Headers(),
        },
      ]);
      stubFetch(502, { error: "Jira rejected the token" });
      // oxlint-disable-next-line vitest/max-expects
      await expect(fetchJiraTickets()).rejects.toThrow(
        "Jira rejected the token"
      );
    });
  });

  describe("Forgejo API", () => {
    it("loads safe settings and omits the token when keeping it", async () => {
      const fetchMock = stubFetch(200, {
        enabled: true,
        url: "https://forge.example.com",
        hasToken: true,
      });
      const response = await fetchForgejoSettings();
      expect(response.hasToken).toBeTruthy();
      expect(fetchMock.mock.calls[0][0]).toBe("/api/forgejo/settings");
      await saveForgejoSettings({
        enabled: false,
        url: "https://forge.example.com",
      });
      expect(
        JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
      ).toStrictEqual({
        enabled: false,
        url: "https://forge.example.com",
      });
      await saveForgejoSettings({
        enabled: false,
        url: "https://forge.example.com",
        clearToken: true,
      });
      expect(
        JSON.parse(String(fetchMock.mock.calls[2][1]?.body)).clearToken
      ).toBeTruthy();
    });

    it("encodes PR identifiers, passes cancellation and surfaces errors", async () => {
      const fetchMock = stubFetch(200, { username: "alice", pulls: [] });
      const { signal } = new AbortController();
      await fetchForgejoPulls("all", signal);
      expect(fetchMock.mock.calls[0]).toStrictEqual([
        "/api/forgejo/pulls?state=all",
        {
          signal,
          cache: "no-store",
          method: "GET",
          body: undefined,
          headers: new Headers(),
        },
      ]);
      await fetchForgejoDiff("team?", "private#", "7", signal);
      expect(fetchMock.mock.calls[1][0]).toBe(
        "/api/forgejo/pulls/team%3F/private%23/7/patch"
      );
      stubFetch(502, { error: "Forgejo rejected the token" });
      await expect(fetchForgejoPulls()).rejects.toThrow(
        "Forgejo rejected the token"
      );
    });

    it("passes inbox filters, resource pagination and unsaved connection credentials", async () => {
      const mock = stubFetch(200, {});
      const { signal } = new AbortController();
      await fetchForgejoPulls(
        {
          state: "open",
          inbox: "review-requested",
          repository: "team/app",
          q: "fix ci",
          page: 3,
        },
        signal
      );
      expect(mock.mock.calls[0][0]).toBe(
        "/api/forgejo/pulls?state=open&inbox=review-requested&repository=team%2Fapp&q=fix+ci&page=3"
      );
      await fetchForgejoDetails("team", "app", "7", signal);
      await fetchForgejoComments("team", "app", "7", 2, signal);
      await fetchForgejoReviews("team", "app", "7", 2, signal);
      await fetchForgejoReviewComments("team", "app", "7", 9, signal);
      await fetchForgejoChecks("team", "app", "a".repeat(40), 2, signal);
      expect(mock.mock.calls.slice(1).map(([url]) => url)).toStrictEqual([
        "/api/forgejo/pulls/team/app/7",
        "/api/forgejo/pulls/team/app/7/comments?page=2",
        "/api/forgejo/pulls/team/app/7/reviews?page=2",
        "/api/forgejo/pulls/team/app/7/reviews/9/comments",
        `/api/forgejo/checks/team/app/${"a".repeat(40)}?page=2`,
      ]);
      for (const [, init] of mock.mock.calls) {
        expect(init).toStrictEqual({
          signal,
          cache: "no-store",
          method: "GET",
          body: undefined,
          headers: new Headers(),
        });
      }
      await testForgejoConnection({
        url: "https://forge.example",
        token: "unsaved",
      });
      expect(mock.mock.calls.at(-1)).toStrictEqual([
        "/api/forgejo/test",
        {
          method: "POST",
          headers: new Headers({ "content-type": "application/json" }),
          body: JSON.stringify({
            url: "https://forge.example",
            token: "unsaved",
          }),
        },
      ]);
    });
  });

  describe("task API", () => {
    it("starts a task and picks a variant", async () => {
      const fetchMock = stubFetch(200, { task: "tsk_1", variants: [] });
      await createTask("demo-1", {
        prompt: "Fix",
        where: "worktree",
        variants: [{}],
      });
      expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/demo-1/tasks");
      expect(
        JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
      ).toStrictEqual({
        prompt: "Fix",
        where: "worktree",
        variants: [{}],
      });
      await pickVariant("demo-1", "tsk/1", "ses_1", true);
      expect(fetchMock.mock.calls[1][0]).toBe(
        "/api/projects/demo-1/tasks/tsk%2F1/pick"
      );
      expect(
        JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
      ).toStrictEqual({
        sessionId: "ses_1",
        removeWorktrees: true,
      });
    });

    it("loads models and surfaces the server's error", async () => {
      stubFetch(412, {
        error: "opencode is not running — start the project first",
      });
      await expect(fetchModels("demo-1")).rejects.toThrow(
        "opencode is not running"
      );
    });
  });

  describe("reply API", () => {
    it("posts a permission decision", async () => {
      const fetchMock = stubFetch(200, { ok: true });
      await expect(
        replyPermission("demo-1", "per/1", "reject", "no")
      ).resolves.toBe("done");
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("/api/projects/demo-1/permissions/per%2F1");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toStrictEqual({
        decision: "reject",
        message: "no",
      });
    });

    it("answers and dismisses forms", async () => {
      const fetchMock = stubFetch(200, { ok: true });
      await replyForm("p", "frm_1", { db: "pg" });
      await dismissForm("p", "frm_1");
      expect(
        fetchMock.mock.calls.map(([u, i]) => [u, i?.method, i?.body])
      ).toStrictEqual([
        [
          "/api/projects/p/forms/frm_1",
          "POST",
          JSON.stringify({ answer: { db: "pg" } }),
        ],
        ["/api/projects/p/forms/frm_1", "DELETE", undefined],
      ]);
    });

    it("reports an item answered elsewhere as gone, not as an error", async () => {
      stubFetch(409, { error: "already answered" });
      await expect(replyPermission("p", "per_1", "once")).resolves.toBe("gone");
    });

    it("throws the server's message for other failures", async () => {
      stubFetch(400, { error: "db is required" });
      await expect(replyForm("p", "frm_1", {})).rejects.toThrow(
        "db is required"
      );
    });
  });

  describe("review API", () => {
    it("fetches review data with directory, base and file in the query", async () => {
      const fetchMock = stubFetch(200, { directory: "/w", files: [] });
      await fetchReview("p", "/w/x", { base: "main", file: "a b.ts" });
      expect(fetchMock.mock.calls[0][0]).toBe(
        "/api/projects/p/review?directory=%2Fw%2Fx&base=main&file=a+b.ts"
      );
      await fetchReview("p", "/w");
      expect(fetchMock.mock.calls[1][0]).toBe(
        "/api/projects/p/review?directory=%2Fw"
      );
      await fetchReview("p", "/w", {
        mode: "turn",
        session: "ses_1",
        from: "msg_2",
      });
      expect(fetchMock.mock.calls[2][0]).toBe(
        "/api/projects/p/review?directory=%2Fw&mode=turn&session=ses_1&from=msg_2"
      );
    });

    it("posts the git actions and prompts", async () => {
      const fetchMock = stubFetch(200, {
        message: "feat: x",
        strategy: "rebase",
        branch: "x",
        sessionId: "ses_9",
      });
      await expect(suggestCommitMessage("p", "/w")).resolves.toBe("feat: x");
      await commitChanges("p", "/w", "m");
      await expect(updateFromBase("p", "/w", "main")).resolves.toMatchObject({
        strategy: "rebase",
      });
      await expect(
        mergeIntoBase("p", "/w", "main", true)
      ).resolves.toMatchObject({ branch: "x" });
      await sendPrompt("p", "ses/1", "fix");
      await expect(startSession("p", "/w", "Review", "look")).resolves.toBe(
        "ses_9"
      );
      await removeWorktree("p", "/w", false, true);
      expect(
        fetchMock.mock.calls.map(([u, i]) => [u, JSON.parse(String(i?.body))])
      ).toStrictEqual([
        ["/api/projects/p/review/commit-message", { directory: "/w" }],
        ["/api/projects/p/review/commit", { directory: "/w", message: "m" }],
        ["/api/projects/p/review/update", { directory: "/w", base: "main" }],
        [
          "/api/projects/p/review/merge",
          { directory: "/w", base: "main", ffOnly: true },
        ],
        ["/api/projects/p/sessions/ses%2F1/prompt", { text: "fix" }],
        [
          "/api/projects/p/sessions",
          { directory: "/w", title: "Review", prompt: "look" },
        ],
        [
          "/api/projects/p/worktrees/remove",
          { path: "/w", force: false, deleteBranch: true },
        ],
      ]);
    });

    it("throws the server's error for a failed review", async () => {
      stubFetch(412, {
        error: "opencode is not running — start the project first",
      });
      await expect(fetchReview("p", "/w")).rejects.toThrow(/not running/u);
    });
  });

  describe("publish API", () => {
    it("reads info and suggestions, and publishes", async () => {
      const fetchMock = stubFetch(200, {
        remotes: [],
        title: "t",
        description: "d",
        strategy: "branch",
        output: [],
      });
      await fetchPublishInfo("p", "/w", "fork");
      expect(fetchMock.mock.calls[0][0]).toBe(
        "/api/projects/p/publish?directory=%2Fw&remote=fork"
      );
      await expect(suggestPublish("p", "/w")).resolves.toMatchObject({
        title: "t",
      });
      await publishChanges("p", "/w", {
        remote: "origin",
        base: "main",
        strategy: "branch",
        title: "T",
        description: "D",
      });
      expect(
        fetchMock.mock.calls
          .slice(1)
          .map(([u, i]) => [u, JSON.parse(String(i?.body))])
      ).toStrictEqual([
        ["/api/projects/p/publish/suggest", { directory: "/w" }],
        [
          "/api/projects/p/publish",
          {
            directory: "/w",
            remote: "origin",
            base: "main",
            strategy: "branch",
            title: "T",
            description: "D",
          },
        ],
      ]);
    });
  });

  describe("environment API", () => {
    it("creates, starts, stops and removes a worktree's container", async () => {
      const fetchMock = stubFetch(200, { envId: "e1" });
      await expect(createEnv("demo-1", "/w/x")).resolves.toStrictEqual({
        envId: "e1",
      });
      expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/demo-1/envs");
      expect(
        JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
      ).toStrictEqual({
        path: "/w/x",
      });
      await envAction("demo-1", "e1", "stop");
      expect(fetchMock.mock.calls[1][0]).toBe(
        "/api/projects/demo-1/envs/e1/stop"
      );
      expect(fetchMock.mock.calls[1][1]?.method).toBe("POST");
      await removeEnv("demo-1", "e1");
      expect(fetchMock.mock.calls[2][0]).toBe(
        "/api/projects/demo-1/envs/e1/remove"
      );
    });
  });

  describe("session API", () => {
    it("removes a session, and surfaces the server's error", async () => {
      const fetchMock = stubFetch(200, { ok: true });
      await removeSession("demo-1", "ses/1");
      expect(fetchMock.mock.calls[0][0]).toBe(
        "/api/projects/demo-1/sessions/ses%2F1"
      );
      expect(fetchMock.mock.calls[0][1]?.method).toBe("DELETE");
      stubFetch(503, {
        error: "opencode is not running — start the project first",
      });
      await expect(removeSession("demo-1", "ses_1")).rejects.toThrow(
        "opencode is not running — start the project first"
      );
    });
  });

  describe("checks API", () => {
    it("lists checks with or without a checkout", async () => {
      const fetchMock = stubFetch(200, {
        checks: [],
        source: "none",
        devcontainer: [],
        errors: [],
      });
      await fetchChecks("demo-1");
      await fetchChecks("demo-1", "/w/a b");
      expect(fetchMock.mock.calls.map((c) => c[0])).toStrictEqual([
        "/api/projects/demo-1/checks",
        "/api/projects/demo-1/checks?directory=%2Fw%2Fa+b",
      ]);
    });

    it("starts a run, polls it and saves settings", async () => {
      const fetchMock = stubFetch(200, { run: { directory: "/w" } });
      await expect(fetchCheckRun("demo-1", "/w")).resolves.toStrictEqual({
        directory: "/w",
      });
      await runChecks("demo-1", "/w", {
        names: ["test"],
        approve: ["docker build ."],
      });
      expect(fetchMock.mock.calls[1][0]).toBe(
        "/api/projects/demo-1/checks/run"
      );
      expect(
        JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
      ).toStrictEqual({
        directory: "/w",
        names: ["test"],
        approve: ["docker build ."],
      });
      await saveChecks("demo-1", null);
      expect(
        JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
      ).toStrictEqual({
        checks: null,
      });
    });

    it("surfaces why a run was refused", async () => {
      stubFetch(400, {
        error: "approve the host command of img before running it",
      });
      await expect(runChecks("demo-1", "/w")).rejects.toThrow(
        "approve the host command"
      );
    });
  });
});
