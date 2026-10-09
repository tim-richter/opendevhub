import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Monitor } from "../../src/server/monitor";
import type { MonitorOptions } from "../../src/server/monitor";
import { OpencodeClient } from "../../src/server/opencode/client";
import type { SessionSummary } from "../../src/shared/types";
import { rawSession, startFakeOpencode } from "../helpers/fake-opencode";
import type { FakeOpencode } from "../helpers/fake-opencode";

let fake: FakeOpencode;
let monitor: Monitor | undefined;
let latest: SessionSummary[] | undefined;
let health: boolean[];

beforeEach(async () => {
  fake = await startFakeOpencode("pw");
  latest = undefined;
  health = [];
});
afterEach(async () => {
  monitor?.stop();
  await fake.close();
});

function start(over: Partial<MonitorOptions> = {}) {
  monitor = new Monitor({
    client: new OpencodeClient({ baseUrl: fake.baseUrl, password: "pw" }),
    projectId: "p",
    directory: "/workspaces/demo",
    onSessions: (s) => (latest = s),
    onHealth: (h) => health.push(h),
    pollMs: 60_000,
    debounceMs: 10,
    minBackoffMs: 20,
    maxBackoffMs: 50,
    ...over,
  });
  monitor.start();
}

describe(Monitor, () => {
  it("hands every poll's raw sessions, subagents included, to onRawSessions", async () => {
    fake.state.sessions = [
      rawSession("ses_1", { cost: 1 }),
      rawSession("ses_2", { parentID: "ses_1", cost: 2 }),
    ];
    const raw: string[][] = [];
    start({ onRawSessions: (s) => raw.push(s.map((x) => x.id)) });
    await vi.waitFor(() =>
      expect(raw.at(-1)).toStrictEqual(["ses_1", "ses_2"])
    );
  });

  it("reconciles immediately on start", async () => {
    fake.state.sessions = [rawSession("ses_1")];
    fake.state.active = ["ses_1"];
    start();
    await vi.waitFor(() =>
      expect(latest?.map((s) => s.status)).toStrictEqual(["running"])
    );
    expect(health).toContain(true);
  });

  it("reconciles shortly after a relevant SSE event", async () => {
    fake.state.sessions = [rawSession("ses_1")];
    start();
    await vi.waitFor(() => expect(latest?.[0].status).toBe("idle"));
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    fake.state.permissions["/workspaces/demo"] = [
      { id: "per_1", sessionID: "ses_1", action: "bash" },
    ];
    fake.emit({ type: "permission.asked", data: { sessionID: "ses_1" } });
    await vi.waitFor(
      () => expect(latest?.[0].status).toBe("needs-permission"),
      { timeout: 2000 }
    );
  });

  it("sees permission requests and questions of sessions working in worktrees", async () => {
    const wt = "/workspaces/demo.worktrees/feature-x";
    fake.state.sessions = [
      rawSession("ses_main"),
      rawSession("ses_wt", { location: { directory: wt } }),
    ];
    fake.state.permissions[wt] = [
      { id: "per_1", sessionID: "ses_wt", action: "bash" },
    ];
    fake.state.forms["/workspaces/demo.worktrees/known"] = [
      { id: "frm_1", sessionID: "ses_main", title: "Q" },
    ];
    start({ extraDirectories: () => ["/workspaces/demo.worktrees/known"] });
    await vi.waitFor(() =>
      expect(
        Object.fromEntries((latest ?? []).map((s) => [s.id, s.status]))
      ).toStrictEqual({
        ses_wt: "needs-permission",
        ses_main: "needs-answer",
      })
    );
  });

  it("stays healthy when a worktree directory is missing in the container", async () => {
    const stale = "/home/me/demo.worktrees/gone";
    fake.state.sessions = [rawSession("ses_1")];
    fake.state.missingDirectories = [stale];
    fake.state.forms["/workspaces/demo"] = [
      { id: "frm_1", sessionID: "ses_1", title: "Q" },
    ];
    start({ pollMs: 30, extraDirectories: () => [stale] });
    await vi.waitFor(() => expect(latest?.[0].status).toBe("needs-answer"));
    await new Promise((r) => setTimeout(r, 150));
    expect(health).not.toContain(false);
  });

  it("fetches flagged sessions and their roots that fall outside the session list", async () => {
    fake.state.sessions = [
      rawSession("ses_new"),
      rawSession("ses_child", { parentID: "ses_root" }),
      rawSession("ses_root"),
      rawSession("ses_asking"),
    ];
    fake.state.listLimit = 2;
    fake.state.permissions["/workspaces/demo"] = [
      { id: "per_1", sessionID: "ses_child", action: "bash" },
    ];
    fake.state.forms["/workspaces/demo"] = [
      { id: "frm_1", sessionID: "ses_asking", title: "Which db?" },
    ];
    start();
    await vi.waitFor(() =>
      expect(latest?.map((s) => [s.id, s.status])).toStrictEqual([
        ["ses_root", "needs-permission"],
        ["ses_asking", "needs-answer"],
        ["ses_new", "idle"],
      ])
    );
  });

  it("reads each root session's context, again only once the session is updated", async () => {
    const usage = (input: number) => ({
      input,
      output: 1,
      reasoning: 0,
      cache: { read: 100, write: 0 },
    });
    fake.state.sessions = [
      rawSession("ses_1", { time: { created: 1, updated: 1 } }),
      rawSession("ses_2", { parentID: "ses_1" }),
    ];
    fake.state.messages = {
      ses_1: [
        { id: "msg_1", type: "assistant", tokens: usage(10) },
        { id: "msg_2", type: "user" },
      ],
    };
    const reads = () =>
      fake.requests.filter((r) => r.includes("/message?")).length;
    start();
    await vi.waitFor(() => expect(latest?.[0]?.context).toBe(111));
    await monitor?.reconcile();
    expect(reads()).toBe(1);

    fake.state.messages.ses_1.push({
      id: "msg_3",
      type: "assistant",
      tokens: usage(50),
    });
    fake.state.sessions[0] = rawSession("ses_1", {
      time: { created: 1, updated: 2 },
    });
    await monitor?.reconcile();
    expect(latest?.[0]?.context).toBe(151);
    expect(reads()).toBe(2);
  });

  it("ignores irrelevant events", async () => {
    start();
    await vi.waitFor(() => expect(latest).toStrictEqual([]));
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    const before = fake.requests.length;
    fake.emit({ type: "model.updated", data: {} });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.requests).toHaveLength(before);
  });

  it("reconnects the event stream after it drops", async () => {
    start();
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    fake.dropStreams();
    expect(fake.sseClientCount()).toBe(0);
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1), {
      timeout: 2000,
    });
  });

  it("polls as a safety net and reports unhealthy after 3 failures", async () => {
    start({ pollMs: 30 });
    await vi.waitFor(() => expect(health).toContain(true));
    fake.state.fail = true;
    await vi.waitFor(() => expect(health.at(-1)).toBeFalsy(), {
      timeout: 2000,
    });
    fake.state.fail = false;
    await vi.waitFor(() => expect(health.at(-1)).toBeTruthy(), {
      timeout: 2000,
    });
  });

  it("stops polling and streaming after stop()", async () => {
    start({ pollMs: 20 });
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    monitor!.stop();
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(0));
    const count = fake.requests.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.requests).toHaveLength(count);
  });

  it("stamps pending items with when they were first seen and forgets answered ones", async () => {
    let clock = 100;
    fake.state.sessions = [rawSession("ses_1")];
    fake.state.permissions["/workspaces/demo"] = [
      {
        id: "per_1",
        sessionID: "ses_1",
        action: "bash",
        resources: ["npm test"],
      },
    ];
    start({ now: () => clock });
    await vi.waitFor(() =>
      expect(latest?.[0].pending?.permissions).toHaveLength(1)
    );
    expect(latest?.[0].pending?.permissions[0]).toMatchObject({
      id: "per_1",
      resources: ["npm test"],
      createdAt: 100,
    });

    clock = 200;
    fake.state.permissions["/workspaces/demo"].push({
      id: "per_2",
      sessionID: "ses_1",
      action: "edit",
    });
    await monitor!.reconcile();
    expect(
      latest?.[0].pending?.permissions.map((p) => [p.id, p.createdAt])
    ).toStrictEqual([
      ["per_1", 100],
      ["per_2", 200],
    ]);

    fake.state.permissions["/workspaces/demo"] = [];
    await monitor!.reconcile();
    expect(latest?.[0].pending).toBeUndefined();

    clock = 300;
    fake.state.permissions["/workspaces/demo"] = [
      { id: "per_1", sessionID: "ses_1", action: "bash" },
    ];
    await monitor!.reconcile();
    expect(latest?.[0].pending?.permissions[0].createdAt).toBe(300);
  });
});
