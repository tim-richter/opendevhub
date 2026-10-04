import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OpencodeClient,
  OpencodeHttpError,
  type OpencodeEvent,
  isGone,
  isInvalidAnswer,
} from "../../src/server/opencode/client";
import { type FakeOpencode, rawSession, startFakeOpencode } from "../helpers/fake-opencode";

let fake: FakeOpencode;
let client: OpencodeClient;
beforeEach(async () => {
  fake = await startFakeOpencode("pw");
  client = new OpencodeClient({ baseUrl: fake.baseUrl, password: "pw" });
});
afterEach(() => fake.close());

describe("OpencodeClient", () => {
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
    expect((await client.sessions()).map((s) => s.id)).toEqual(["ses_1"]);
    expect(await client.active()).toEqual(new Set(["ses_1"]));
  });

  it("scopes permission requests and forms by directory header", async () => {
    fake.state.permissions["/w/other"] = [{ id: "per_1", sessionID: "ses_1", action: "bash" }];
    fake.state.forms["/w/other"] = [{ id: "frm_1", sessionID: "ses_2", title: "Q" }];
    expect(await client.permissionRequests("/workspaces/demo")).toEqual([]);
    expect((await client.permissionRequests("/w/other")).map((p) => p.id)).toEqual(["per_1"]);
    expect((await client.forms("/w/other")).map((f) => f.id)).toEqual(["frm_1"]);
  });

  it("creates a session in a given directory", async () => {
    const created = await client.createSession("/workspaces/demo.worktrees/x", "feature/x");
    expect(created).toMatchObject({ title: "feature/x", location: { directory: "/workspaces/demo.worktrees/x" } });
    expect(fake.state.sessions[0].id).toBe(created.id);
    expect(fake.requests).toContain("POST /api/session");
  });

  it("streams parsed SSE events, skipping comments, until aborted", async () => {
    const events: OpencodeEvent[] = [];
    const ac = new AbortController();
    const done = client.subscribe((e) => events.push(e), ac.signal).catch(() => {});
    await expect.poll(() => fake.sseClientCount()).toBe(1);
    fake.emit({ type: "session.created", data: { sessionID: "ses_9" } });
    await expect.poll(() => events.map((e) => e.type)).toEqual(["server.connected", "session.created"]);
    ac.abort();
    await done;
  });

  it("subscribe rejects on auth failure", async () => {
    const bad = new OpencodeClient({ baseUrl: fake.baseUrl, password: "nope" });
    await expect(bad.subscribe(() => {}, new AbortController().signal)).rejects.toMatchObject({ status: 401 });
  });
  it("replies to a permission request on behalf of the asking session", async () => {
    fake.state.permissions["/w/x"] = [{ id: "per_1", sessionID: "ses_child", action: "bash" }];
    await client.replyPermission("ses_child", "per_1", { decision: "reject", message: "not now" }, "/w/x");
    expect(fake.state.replies).toEqual([
      { method: "POST", path: "/api/session/ses_child/permission/per_1/reply", body: { decision: "reject", message: "not now" } },
    ]);
    expect(fake.state.permissions["/w/x"]).toEqual([]);
  });

  it("answers and cancels forms", async () => {
    fake.state.forms["/w"] = [
      { id: "frm_1", sessionID: "ses_1", title: "Q" },
      { id: "frm_2", sessionID: "ses_1", title: "Q2" },
    ];
    await client.replyForm("ses_1", "frm_1", { db: "postgres", n: 2 });
    await client.cancelForm("ses_1", "frm_2", "/w");
    expect(fake.state.replies).toEqual([
      { method: "POST", path: "/api/session/ses_1/form/frm_1/reply", body: { answer: { db: "postgres", n: 2 } } },
      { method: "DELETE", path: "/api/session/ses_1/form/frm_2", body: undefined },
    ]);
    expect(fake.state.forms["/w"]).toEqual([]);
  });

  it("classifies opencode's errors: gone vs invalid answer", async () => {
    const notFound = await client.replyPermission("ses_1", "per_x", { decision: "once" }).catch((e: unknown) => e);
    expect(notFound).toMatchObject({ status: 404, tag: "PermissionNotFoundError" });
    expect(isGone(notFound)).toBe(true);

    fake.state.forms["/w"] = [{ id: "frm_1", sessionID: "ses_1", title: "Q" }];
    fake.state.invalidAnswer = "db is required";
    const invalid = await client.replyForm("ses_1", "frm_1", {}).catch((e: unknown) => e);
    expect(invalid).toMatchObject({ status: 400, tag: "FormInvalidAnswerError", detail: "db is required" });
    expect(isInvalidAnswer(invalid)).toBe(true);
    expect(isGone(invalid)).toBe(false);

    fake.state.settledForms = ["frm_1"];
    const settled = await client.replyForm("ses_1", "frm_1", {}).catch((e: unknown) => e);
    expect(settled).toMatchObject({ status: 409, tag: "FormAlreadySettledError" });
    expect(isGone(settled)).toBe(true);
    expect(isInvalidAnswer(settled)).toBe(false);
  });

  it("keeps the status when the error body is not JSON", async () => {
    fake.state.plainErrors = true;
    const err = await client.cancelForm("ses_1", "frm_missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpencodeHttpError);
    expect(err).toMatchObject({ status: 404, tag: undefined });
    expect(isGone(err)).toBe(true);
  });
});
