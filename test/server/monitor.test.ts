import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Monitor, type MonitorOptions } from "../../src/server/monitor";
import { OpencodeClient } from "../../src/server/opencode/client";
import type { SessionSummary } from "../../src/shared/types";
import { type FakeOpencode, rawSession, startFakeOpencode } from "../helpers/fake-opencode";

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

describe("Monitor", () => {
  it("reconciles immediately on start", async () => {
    fake.state.sessions = [rawSession("ses_1")];
    fake.state.active = ["ses_1"];
    start();
    await vi.waitFor(() => expect(latest?.map((s) => s.status)).toEqual(["running"]));
    expect(health).toContain(true);
  });

  it("reconciles shortly after a relevant SSE event", async () => {
    fake.state.sessions = [rawSession("ses_1")];
    start();
    await vi.waitFor(() => expect(latest?.[0].status).toBe("idle"));
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    fake.state.permissions["/workspaces/demo"] = [{ id: "per_1", sessionID: "ses_1", action: "bash" }];
    fake.emit({ type: "permission.asked", data: { sessionID: "ses_1" } });
    await vi.waitFor(() => expect(latest?.[0].status).toBe("needs-permission"), { timeout: 2000 });
  });

  it("ignores irrelevant events", async () => {
    start();
    await vi.waitFor(() => expect(latest).toEqual([]));
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    const before = fake.requests.length;
    fake.emit({ type: "model.updated", data: {} });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.requests.length).toBe(before);
  });

  it("reconnects the event stream after it drops", async () => {
    start();
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    fake.dropStreams();
    expect(fake.sseClientCount()).toBe(0);
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1), { timeout: 2000 });
  });

  it("polls as a safety net and reports unhealthy after 3 failures", async () => {
    start({ pollMs: 30 });
    await vi.waitFor(() => expect(health).toContain(true));
    fake.state.fail = true;
    await vi.waitFor(() => expect(health.at(-1)).toBe(false), { timeout: 2000 });
    fake.state.fail = false;
    await vi.waitFor(() => expect(health.at(-1)).toBe(true), { timeout: 2000 });
  });

  it("stops polling and streaming after stop()", async () => {
    start({ pollMs: 20 });
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    monitor!.stop();
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(0));
    const count = fake.requests.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.requests.length).toBe(count);
  });
});
