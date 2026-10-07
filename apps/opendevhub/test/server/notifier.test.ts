import { describe, expect, it, vi } from "vitest";

import { startNotifier } from "../../src/server/notifier";
import { StateStore } from "../../src/server/state";
import type { Notice } from "../../src/shared/notices";
import type { Project, SessionSummary } from "../../src/shared/types";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/x",
};
const session = (over: Partial<SessionSummary>): SessionSummary => ({
  id: "ses_1",
  projectId: project.id,
  title: "Fix it",
  directory: "/w",
  updatedAt: 1,
  status: "running",
  ...over,
});
const asking = (ids: string[]) =>
  session({
    status: "needs-permission",
    pending: {
      permissions: ids.map((id) => ({
        id,
        sessionId: "ses_1",
        action: "bash",
        resources: ["ls"],
      })),
      forms: [],
    },
  });

function setup() {
  const store = new StateStore({
    port: 7777,
    persisted: { projects: {} },
    persist: () => {},
  });
  store.setProjects([project]);
  const send = vi.fn(async (_notice: Notice) => 1);
  return { store, send };
}

describe(startNotifier, () => {
  it("does not notify what was already waiting when it started", () => {
    const { store, send } = setup();
    store.setSessions(project.id, [asking(["r1"])]);
    startNotifier(store, { send });
    store.setSessions(project.id, [asking(["r1"])]);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends each new notice once, as the store changes", () => {
    const { store, send } = setup();
    store.setSessions(project.id, [session({})]);
    const stop = startNotifier(store, { send });
    store.setSessions(project.id, [asking(["r1"])]);
    store.setSessions(project.id, [asking(["r1", "r2"])]);
    store.setSessions(project.id, [asking(["r1", "r2"])]);
    expect(send.mock.calls.map(([n]) => [n.tag, n.permission])).toStrictEqual([
      ["perm:r1", { requestId: "r1" }],
      ["perm:r2", { requestId: "r2" }],
    ]);
    stop();
    store.setSessions(project.id, [session({ status: "idle" })]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("keeps going when a send rejects", async () => {
    const { store, send } = setup();
    send.mockRejectedValue(new Error("boom"));
    startNotifier(store, { send });
    store.setSessions(project.id, [asking(["r1"])]);
    await Promise.resolve();
    store.setSessions(project.id, [asking(["r1", "r2"])]);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
