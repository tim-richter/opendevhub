import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpencodeClient, OpencodeHttpError, type OpencodeEvent } from "../../src/server/opencode/client";
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
});
