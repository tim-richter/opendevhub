import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OpencodeClient,
  OpencodeHttpError,
  isGone,
  isInvalidAnswer,
  toAttachments,
} from "../../../src/server/opencode/client";
import type { OpencodeEvent } from "../../../src/server/opencode/client";
import {
  rawSession,
  rawShell,
  startFakeOpencode,
} from "../../helpers/fake-opencode";
import type { FakeOpencode } from "../../helpers/fake-opencode";

let fake: FakeOpencode;
let client: OpencodeClient;
beforeEach(async () => {
  fake = await startFakeOpencode("pw");
  client = new OpencodeClient({ baseUrl: fake.baseUrl, password: "pw" });
});
afterEach(() => fake.close());

describe(OpencodeClient, () => {
  it("reads info with basic auth", async () => {
    expect((await client.info()).version).toBe("2.0.20");
  });

  it("throws OpencodeHttpError with status on wrong password", async () => {
    const bad = new OpencodeClient({ baseUrl: fake.baseUrl, password: "nope" });
    await expect(bad.info()).rejects.toMatchObject({ status: 401 });
    await expect(bad.info()).rejects.toBeInstanceOf(OpencodeHttpError);
  });

  it("lists sessions and active ids", async () => {
    fake.state.sessions = [rawSession("ses_1")];
    fake.state.active = ["ses_1"];
    expect((await client.sessions()).map((s) => s.id)).toStrictEqual(["ses_1"]);
    await expect(client.active()).resolves.toStrictEqual(new Set(["ses_1"]));
  });

  it("gets a chat's child agents even when the recent session page contains another session", async () => {
    fake.state.sessions = [
      rawSession("ses_other"),
      rawSession("ses_agent", { parentID: "ses_chat" }),
      rawSession("ses_chat"),
    ];
    fake.state.listLimit = 1;
    expect(
      (await client.sessions()).map((session) => session.id)
    ).toStrictEqual(["ses_other"]);
    expect(
      (await client.childSessions("ses_chat")).map((session) => session.id)
    ).toStrictEqual(["ses_agent"]);
  });

  it("follows the list cursor for every session, up to the cap", async () => {
    fake.state.sessions = Array.from({ length: 450 }, (_, i) =>
      rawSession(`ses_${i}`)
    );
    fake.state.listLimit = 50;
    expect(await client.sessions()).toHaveLength(50);
    const all = await client.allSessions();
    expect(all.map((s) => s.id)).toStrictEqual(
      fake.state.sessions.map((s) => s.id)
    );
    const lists = fake.requests.filter((r) =>
      r.startsWith("GET /api/session?")
    );
    expect(lists[0]).toBe("GET /api/session?limit=200");
    expect(
      lists.slice(1).every((r) => /^GET \/api\/session\?cursor=/u.test(r))
    ).toBe(true);
    const capped: number[] = [];
    expect(
      await client.allSessions({ cap: 300, onCapped: (n) => capped.push(n) })
    ).toHaveLength(300);
    expect(capped).toStrictEqual([300]);
  });

  it("lists a directory's running shells and kills one there", async () => {
    fake.state.shells = {
      "/w/other": [
        rawShell("sh_1", "ses_1"),
        rawShell("sh_2", "ses_1", { status: "exited" }),
      ],
    };
    await expect(client.shells("/workspaces/demo")).resolves.toStrictEqual([]);
    expect((await client.shells("/w/other")).map((s) => s.id)).toStrictEqual([
      "sh_1",
    ]);
    await client.killShell("sh_1", "/w/other");
    expect(fake.state.killedShells).toStrictEqual(["sh_1"]);
    await expect(client.shells("/w/other")).resolves.toStrictEqual([]);
  });

  it("scopes permission requests and forms by directory header", async () => {
    fake.state.permissions["/w/other"] = [
      { id: "per_1", sessionID: "ses_1", action: "bash" },
    ];
    fake.state.forms["/w/other"] = [
      { id: "frm_1", sessionID: "ses_2", title: "Q" },
    ];
    await expect(
      client.permissionRequests("/workspaces/demo")
    ).resolves.toStrictEqual([]);
    expect(
      (await client.permissionRequests("/w/other")).map((p) => p.id)
    ).toStrictEqual(["per_1"]);
    expect((await client.forms("/w/other")).map((f) => f.id)).toStrictEqual([
      "frm_1",
    ]);
  });

  it("creates a session in a given directory", async () => {
    const created = await client.createSession("/workspaces/demo.worktrees/x", {
      title: "feature/x",
    });
    expect(created).toMatchObject({
      title: "feature/x",
      location: { directory: "/workspaces/demo.worktrees/x" },
    });
    expect(fake.state.sessions[0].id).toBe(created.id);
    expect(fake.requests).toContain("POST /api/session");
  });

  it("creates a session with a model, agent and metadata", async () => {
    const meta = {
      opendevhub: { task: "tsk_1", variant: 1, of: 1, title: "T" },
    };
    const created = await client.createSession("/w/x", {
      title: "T",
      model: { id: "m", providerID: "p" },
      agent: "build",
      metadata: meta,
    });
    expect(created).toMatchObject({
      title: "T",
      model: { id: "m", providerID: "p" },
      agent: "build",
      metadata: meta,
      location: { directory: "/w/x" },
    });
  });

  it("surfaces opencode's error when a session can't be created", async () => {
    fake.state.rejectModels = ["nope"];
    await expect(
      client.createSession("/w", { model: { id: "nope", providerID: "p" } })
    ).rejects.toMatchObject({
      status: 400,
      tag: "ModelNotFoundError",
    });
  });

  it("lists models, the default model and agents for a directory", async () => {
    fake.state.models = [
      {
        id: "m1",
        providerID: "p",
        name: "M1",
        enabled: true,
        variants: [],
        settings: { apiKey: "k" },
      },
    ];
    fake.state.defaultModel = fake.state.models[0];
    fake.state.agents = [
      { id: "build", name: "Build", mode: "primary", hidden: false },
    ];
    expect((await client.models("/w")).map((m) => m.id)).toStrictEqual(["m1"]);
    expect((await client.defaultModel("/w"))?.id).toBe("m1");
    expect((await client.agents("/w")).map((a) => a.id)).toStrictEqual([
      "build",
    ]);
    fake.state.defaultModel = null;
    await expect(client.defaultModel("/w")).resolves.toBeUndefined();
    expect(fake.requests).toContain("GET /api/model/default");
  });

  it("patches a session's metadata, which opencode replaces as a whole", async () => {
    fake.state.sessions = [rawSession("ses_1", { metadata: { keep: 1 } })];
    await client.updateSession(
      "ses_1",
      { metadata: { opendevhub: { discarded: true } } },
      "/w"
    );
    expect(fake.state.patches).toStrictEqual([
      {
        sessionId: "ses_1",
        body: { metadata: { opendevhub: { discarded: true } } },
      },
    ]);
    expect(fake.state.sessions[0].metadata).toStrictEqual({
      opendevhub: { discarded: true },
    });
  });

  it("streams parsed SSE events, skipping comments, until aborted", async () => {
    const events: OpencodeEvent[] = [];
    const ac = new AbortController();
    const done = client
      .subscribe((e) => events.push(e), ac.signal)
      .catch(() => undefined);
    await expect.poll(() => fake.sseClientCount()).toBe(1);
    fake.emit({ type: "session.created", data: { sessionID: "ses_9" } });
    await expect
      .poll(() => events.map((e) => e.type))
      .toStrictEqual(["server.connected", "session.created"]);
    ac.abort();
    await done;
  });

  it("subscribe rejects on auth failure", async () => {
    const bad = new OpencodeClient({ baseUrl: fake.baseUrl, password: "nope" });
    await expect(
      bad.subscribe(() => {}, new AbortController().signal)
    ).rejects.toMatchObject({ status: 401 });
  });

  it("replies to a permission request on behalf of the asking session", async () => {
    fake.state.permissions["/w/x"] = [
      { id: "per_1", sessionID: "ses_child", action: "bash" },
    ];
    await client.replyPermission(
      "ses_child",
      "per_1",
      { decision: "reject", message: "not now" },
      "/w/x"
    );
    expect(fake.state.replies).toStrictEqual([
      {
        method: "POST",
        path: "/api/session/ses_child/permission/per_1/reply",
        body: { decision: "reject", message: "not now" },
      },
    ]);
    expect(fake.state.permissions["/w/x"]).toStrictEqual([]);
  });

  it("answers and cancels forms", async () => {
    fake.state.forms["/w"] = [
      { id: "frm_1", sessionID: "ses_1", title: "Q" },
      { id: "frm_2", sessionID: "ses_1", title: "Q2" },
    ];
    await client.replyForm("ses_1", "frm_1", { db: "postgres", n: 2 });
    await client.cancelForm("ses_1", "frm_2", "/w");
    expect(fake.state.replies).toStrictEqual([
      {
        method: "POST",
        path: "/api/session/ses_1/form/frm_1/reply",
        body: { answer: { db: "postgres", n: 2 } },
      },
      {
        method: "DELETE",
        path: "/api/session/ses_1/form/frm_2",
        body: undefined,
      },
    ]);
    expect(fake.state.forms["/w"]).toStrictEqual([]);
  });

  it("classifies opencode's errors: gone vs invalid answer", async () => {
    const notFound = await client
      .replyPermission("ses_1", "per_x", { decision: "once" })
      .catch((error: unknown) => error);
    expect(notFound).toMatchObject({
      status: 404,
      tag: "PermissionNotFoundError",
    });
    expect(isGone(notFound)).toBeTruthy();

    fake.state.forms["/w"] = [{ id: "frm_1", sessionID: "ses_1", title: "Q" }];
    fake.state.invalidAnswer = "db is required";
    const invalid = await client
      .replyForm("ses_1", "frm_1", {})
      .catch((error: unknown) => error);
    expect(invalid).toMatchObject({
      status: 400,
      tag: "FormInvalidAnswerError",
      detail: "db is required",
    });
    expect(isInvalidAnswer(invalid)).toBeTruthy();
    expect(isGone(invalid)).toBeFalsy();

    fake.state.settledForms = ["frm_1"];
    const settled = await client
      .replyForm("ses_1", "frm_1", {})
      .catch((error: unknown) => error);
    expect(settled).toMatchObject({
      status: 409,
      tag: "FormAlreadySettledError",
    });
    expect(isGone(settled)).toBeTruthy();
    expect(isInvalidAnswer(settled)).toBeFalsy();
  });

  it("keeps the status when the error body is not JSON", async () => {
    fake.state.plainErrors = true;
    const err = await client
      .cancelForm("ses_1", "frm_missing")
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(OpencodeHttpError);
    expect(err).toMatchObject({ status: 404, tag: undefined });
    expect(isGone(err)).toBeTruthy();
  });

  it("reads vcs info, base, status and diff for a directory", async () => {
    fake.state.vcs["/w/x"] = {
      current: "feature/x",
      default: "main",
      base: "develop",
      status: [
        { file: "a.ts", additions: 1, deletions: 0, status: "modified" },
      ],
      diff: {
        branch: [
          {
            file: "a.ts",
            patch: "@@ -1 +1 @@\n-a\n+b\n",
            additions: 1,
            deletions: 1,
            status: "modified",
          },
        ],
      },
    };
    await expect(client.vcsInfo("/w/x")).resolves.toStrictEqual({
      current: "feature/x",
      default: "main",
    });
    await expect(client.vcsBase("/w/x")).resolves.toBe("develop");
    await expect(client.vcsStatus("/w/x")).resolves.toHaveLength(1);
    expect(
      (await client.vcsDiff("/w/x", "branch", "develop")).map((f) => f.file)
    ).toStrictEqual(["a.ts"]);
    expect(fake.state.diffQueries).toStrictEqual([
      { directory: "/w/x", mode: "branch", base: "develop" },
    ]);
  });

  it("reads a session's prompts and what one of its turns changed", async () => {
    fake.state.messages = {
      ses_1: [
        { id: "msg_1", type: "user", text: "first", time: { created: 1 } },
        { id: "msg_2", type: "assistant" },
        { id: "msg_3", type: "user", text: "second", time: { created: 3 } },
      ],
    };
    const changed = {
      file: "a.ts",
      patch: "@@ -1 +1 @@\n-a\n+b\n",
      additions: 1,
      deletions: 1,
      status: "modified" as const,
    };
    fake.state.turnDiffs = { ses_1: { msg_1: [changed], msg_3: [] } };
    expect(
      (await client.userMessages("ses_1", 10)).map((m) => m.id)
    ).toStrictEqual(["msg_3", "msg_1"]);
    await expect(
      client.sessionDiff("ses_1", {}, "/w/x")
    ).resolves.toStrictEqual([]);
    await expect(
      client.sessionDiff("ses_1", { from: "msg_1" }, "/w/x")
    ).resolves.toStrictEqual([changed]);
    expect(fake.state.turnQueries).toStrictEqual([
      { sessionId: "ses_1" },
      { sessionId: "ses_1", from: "msg_1" },
    ]);
    await expect(
      client.sessionDiff("ses_1", { from: "msg_9" })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("treats an ambiguous or missing base as unknown", async () => {
    fake.state.vcs["/w/a"] = { base: "ambiguous" };
    fake.state.vcs["/w/b"] = { base: null };
    await expect(client.vcsBase("/w/a")).resolves.toBeUndefined();
    await expect(client.vcsBase("/w/b")).resolves.toBeUndefined();
  });

  it("deletes a session, which opencode does with its subagent sessions", async () => {
    fake.state.sessions = [
      rawSession("ses_1"),
      rawSession("ses_2", { parentID: "ses_1" }),
      rawSession("ses_3"),
    ];
    await client.deleteSession("ses_1", "/w/x");
    expect(fake.state.deleted).toStrictEqual(["ses_1"]);
    expect(fake.state.sessions.map((s) => s.id)).toStrictEqual(["ses_3"]);
    await expect(client.deleteSession("ses_9")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("interrupts a session", async () => {
    await client.interrupt("ses_1", "/w/x");
    expect(fake.state.interrupts).toStrictEqual(["ses_1"]);
  });

  it("stages, clears and commits a session's revert", async () => {
    const files = [
      {
        file: "a.ts",
        patch: "",
        additions: 2,
        deletions: 1,
        status: "modified" as const,
      },
    ];
    fake.state.sessions = [rawSession("ses_1")];
    fake.state.revertFiles = { ses_1: files };
    await expect(
      client.stageRevert("ses_1", "msg_2", "/w/x")
    ).resolves.toStrictEqual({ files, messageID: "msg_2" });
    expect((await client.session("ses_1")).revert?.messageID).toBe("msg_2");
    await client.clearRevert("ses_1", "/w/x");
    expect((await client.session("ses_1")).revert).toBeUndefined();
    await client.stageRevert("ses_1", "msg_2");
    await client.commitRevert("ses_1");
    expect(fake.state.reverts).toStrictEqual([
      {
        body: { files: true, messageID: "msg_2" },
        call: "stage",
        sessionId: "ses_1",
      },
      { call: "clear", sessionId: "ses_1" },
      {
        body: { files: true, messageID: "msg_2" },
        call: "stage",
        sessionId: "ses_1",
      },
      { call: "commit", sessionId: "ses_1" },
    ]);
  });

  it("surfaces opencode's busy error when staging a revert while the session runs", async () => {
    fake.state.sessions = [rawSession("ses_1")];
    fake.state.active = ["ses_1"];
    await expect(client.stageRevert("ses_1", "msg_2")).rejects.toMatchObject({
      status: 409,
      tag: "SessionBusyError",
    });
  });

  it("switches a session's model", async () => {
    const model = { id: "gpt-5", providerID: "openai", variant: "high" };
    await client.switchModel("ses_1", model, "/w/x");
    expect(fake.state.modelSwitches).toStrictEqual([
      { body: { model }, sessionId: "ses_1" },
    ]);
  });

  it("puts a session's instruction entry on opencode's experimental route", async () => {
    await client.putInstruction("ses_1", "opendevhub-task", "# Task", "/w/x");
    expect(fake.requests).toContain(
      "PUT /api/experimental/session/ses_1/instructions/entries/opendevhub-task"
    );
    expect(fake.state.instructions).toStrictEqual({
      ses_1: { "opendevhub-task": "# Task" },
    });
  });

  it("surfaces an opencode without the instructions route as a 404", async () => {
    fake.state.noInstructions = true;
    await expect(
      client.putInstruction("ses_1", "opendevhub-task", "# Task")
    ).rejects.toMatchObject({ status: 404 });
  });

  it("switches a session's agent", async () => {
    await client.switchAgent("ses_1", "plan", "/w/x");
    expect(fake.state.agentSwitches).toStrictEqual([
      { body: { agent: "plan" }, sessionId: "ses_1" },
    ]);
  });

  it("reports a clear message when a request is aborted by its deadline", async () => {
    const hung = new OpencodeClient(
      { baseUrl: fake.baseUrl, password: "pw" },
      async () => {
        throw new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError"
        );
      }
    );
    await expect(hung.prompt("ses_1", "hi")).rejects.toThrow(
      "opencode did not respond to POST /api/session/ses_1/prompt within 5 s"
    );
  });

  it("gives session creation and the first turn a caller-supplied deadline", async () => {
    const hung = new OpencodeClient(
      { baseUrl: fake.baseUrl, password: "pw" },
      async () => {
        throw new DOMException(
          "The operation was aborted due to timeout",
          "TimeoutError"
        );
      }
    );
    await expect(hung.createSession("/w/x", {}, 60_000)).rejects.toThrow(
      "opencode did not respond to POST /api/session within 60 s"
    );
    await expect(
      hung.prompt("ses_1", "hi", undefined, undefined, {}, 60_000)
    ).rejects.toThrow("within 60 s");
    await expect(
      hung.command("ses_1", "review", "", undefined, { timeoutMs: 60_000 })
    ).rejects.toThrow("within 60 s");
    await expect(hung.commands("/w/x", 60_000)).rejects.toThrow("within 60 s");
  });

  it("passes network errors that are not a deadline abort through unchanged", async () => {
    const boom = new Error("something is wrong");
    const broken = new OpencodeClient(
      { baseUrl: fake.baseUrl, password: "pw" },
      async () => {
        throw boom;
      }
    );
    await expect(broken.info()).rejects.toBe(boom);
  });

  it("sends prompts, queued when asked, and generates text from a session", async () => {
    await client.prompt("ses_1", "fix it", "queue", "/w/x");
    await client.prompt("ses_2", "hello");
    expect(fake.state.prompts).toStrictEqual([
      {
        sessionId: "ses_1",
        body: { text: "fix it", delivery: "queue" },
        directory: "/w/x",
      },
      { sessionId: "ses_2", body: { text: "hello" }, directory: undefined },
    ]);
    fake.state.generated = "feat: add login";
    await expect(client.generate("ses_1", "write a message")).resolves.toBe(
      "feat: add login"
    );
    fake.state.generateFails = true;
    await expect(client.generate("ses_1", "x")).rejects.toBeInstanceOf(
      OpencodeHttpError
    );
  });

  it("finds files in a checkout through opencode's fs/find, capped", async () => {
    fake.state.files = {
      "/w/x": [
        { path: "src/auth/", type: "directory" },
        { path: "src/auth/login.ts", type: "file" },
        { path: "src/auth/logout.ts", type: "file" },
      ],
    };
    await expect(client.findFiles("/w/x", "auth", 50)).resolves.toStrictEqual([
      "src/auth/login.ts",
      "src/auth/logout.ts",
    ]);
    await expect(client.findFiles("/w/x", "auth", 1)).resolves.toStrictEqual([
      "src/auth/login.ts",
    ]);
    await expect(
      client.findFiles("/w/other", "auth", 50)
    ).resolves.toStrictEqual([]);
    expect(fake.state.findQueries[0]).toBe("?limit=50&query=auth&type=file");
  });

  it("sends mentions as opencode's file and agent attachments, on prompts and commands", async () => {
    const message = "/review explain @src/a.ts with @explore";
    const mentions = [
      { kind: "file" as const, start: 16, end: 25, name: "src/a.ts" },
      { kind: "agent" as const, start: 31, end: 39, name: "explore" },
    ];
    await client.prompt(
      "ses_1",
      message,
      undefined,
      "/w/x",
      toAttachments("/w/x", message, mentions)
    );
    await client.command("ses_1", "review", message.slice(8), "/w/x", {
      ...toAttachments("/w/x", message, mentions, 8),
      delivery: "queue",
    });
    expect(fake.state.prompts[0].body).toStrictEqual({
      text: message,
      files: [
        {
          uri: "file:///w/x/src/a.ts",
          name: "src/a.ts",
          mention: { start: 16, end: 25, text: "@src/a.ts" },
        },
      ],
      agents: [
        { name: "explore", mention: { start: 31, end: 39, text: "@explore" } },
      ],
    });
    expect(fake.state.commandRuns).toStrictEqual([
      {
        sessionId: "ses_1",
        directory: "/w/x",
        body: {
          name: "review",
          text: "explain @src/a.ts with @explore",
          files: [
            {
              uri: "file:///w/x/src/a.ts",
              name: "src/a.ts",
              mention: { start: 8, end: 17, text: "@src/a.ts" },
            },
          ],
          agents: [
            {
              name: "explore",
              mention: { start: 23, end: 31, text: "@explore" },
            },
          ],
          delivery: "queue",
        },
      },
    ]);
  });
});

describe(toAttachments, () => {
  it("sends nothing extra without mentions, and encodes paths as file URLs", () => {
    expect(toAttachments("/w/x", "hi", [])).toStrictEqual({});
    expect(
      toAttachments("/w/my repo", "@a b.ts", [
        { kind: "file", start: 0, end: 7, name: "a b.ts" },
      ]).files?.[0].uri
    ).toBe("file:///w/my%20repo/a%20b.ts");
  });

  it("refuses paths outside the checkout and ranges that don't match the text", () => {
    for (const name of ["../etc/passwd", "/etc/passwd", "a/../../b", "a//b"]) {
      const text = `@${name}`;
      expect(() =>
        toAttachments("/w/x", text, [
          { kind: "file", start: 0, end: text.length, name },
        ])
      ).toThrow(RangeError);
    }
    expect(() =>
      toAttachments("/w/x", "see @a.ts", [
        { kind: "file", start: 0, end: 5, name: "a.ts" },
      ])
    ).toThrow(RangeError);
  });
});
