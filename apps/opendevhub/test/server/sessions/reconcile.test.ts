import { describe, expect, it, vi } from "vitest";

import { eventsSince, variantActor } from "../../../src/server/db/events";
import type { RawSession } from "../../../src/server/opencode/client";
import { reconcileTasks } from "../../../src/server/sessions/reconcile";
import type { Presence } from "../../../src/server/sessions/reconcile";
import type { Project } from "../../../src/shared/types";
import { memoryStores } from "../../helpers/stores";

const project: Project = {
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
};
const T1 = "tsk_01JA0000000000000000000001";
const WS = "/workspaces/demo";

const raw = (id: string, over: Partial<RawSession> = {}): RawSession => ({
  id,
  location: { directory: WS },
  time: { created: 100, updated: 200 },
  title: `Session ${id}`,
  ...over,
});

const setup = () => {
  const s = memoryStores(() => 1000);
  s.projects.upsertAll([project]);
  const lookup = vi.fn(async (_id: string): Promise<Presence> => "gone");
  const run = (sessions: RawSession[], envId = project.id) =>
    reconcileTasks(s.tasks, {
      branchOf: (dir) => (dir === WS ? undefined : "feat"),
      envId,
      lookup,
      projectId: project.id,
      sessions,
    });
  const verbs = () => eventsSince(s.db).map((e) => `${e.verb} ${e.object.id}`);
  return { ...s, lookup, run, verbs };
};

describe("reconcileTasks", () => {
  it("adopts top-level sessions without a task, skipping subagents and archived ones", async () => {
    const s = setup();
    await s.run([
      raw("ses_a", { location: { directory: "/w/feat" } }),
      raw("ses_child", { parentID: "ses_a" }),
      raw("ses_old", { time: { archived: 150, created: 1, updated: 2 } }),
    ]);
    const tasks = s.tasks.listForProject(project.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      createdAt: 100,
      kind: "manual",
      state: "running",
      title: "Session ses_a",
      variants: [
        {
          branch: "feat",
          directory: "/w/feat",
          envId: project.id,
          sessionId: "ses_a",
          step: "session",
        },
      ],
    });
    expect(s.tasks.sessionRef("ses_child")).toBeUndefined();
    expect(s.verbs()).toContain("session.adopted ses_a");
  });

  it("writes nothing on a second pass with the same sessions", async () => {
    const s = setup();
    await s.run([raw("ses_a")]);
    const before = s.verbs().length;
    await s.run([raw("ses_a")]);
    expect(s.verbs()).toHaveLength(before);
    expect(s.tasks.listForProject(project.id)).toHaveLength(1);
  });

  it("leaves a session in a claimed directory to its creator until it is attached", async () => {
    const s = setup();
    s.tasks.createTask({
      createdAt: 1,
      id: T1,
      projectId: project.id,
      prompt: "p",
      title: "Fix",
      variants: [{}],
    });
    const release = s.tasks.claim(project.id, WS);
    await s.run([raw("ses_t")]);
    expect(s.tasks.sessionRef("ses_t")).toBeUndefined();
    s.tasks.attachSession(
      T1,
      1,
      { directory: WS, envId: project.id, sessionId: "ses_t" },
      variantActor(T1, 1)
    );
    release();
    await s.run([raw("ses_t")]);
    expect(s.tasks.sessionRef("ses_t")?.id).toBe(T1);
    expect(s.tasks.listForProject(project.id)).toHaveLength(1);
  });

  it("lets a manual task's title follow its session", async () => {
    const s = setup();
    await s.run([raw("ses_a", { title: "" })]);
    expect(s.tasks.listForProject(project.id)[0].title).toBe(
      "Untitled session"
    );
    await s.run([raw("ses_a", { title: "Fix the flaky test" })]);
    expect(s.tasks.listForProject(project.id)[0].title).toBe(
      "Fix the flaky test"
    );
  });

  it("marks a deleted or archived session removed, and clears it when it is listed again", async () => {
    const s = setup();
    await s.run([raw("ses_a"), raw("ses_b")]);
    await s.run([
      raw("ses_b", { time: { archived: 300, created: 100, updated: 300 } }),
    ]);
    expect(s.lookup).toHaveBeenCalledWith("ses_a");
    // Both were created at the same time, so their order is the ids' random part: sort by session.
    const states = () =>
      s.tasks
        .listForProject(project.id)
        .map((t) => [t.variants[0].sessionId, t.state])
        .toSorted(([a], [b]) => String(a).localeCompare(String(b)));
    expect(states()).toStrictEqual([
      ["ses_a", "ended"],
      ["ses_b", "ended"],
    ]);
    await s.run([raw("ses_a")]);
    expect(states()).toStrictEqual([
      ["ses_a", "running"],
      ["ses_b", "ended"],
    ]);
  });

  it("keeps a session the listing left out when opencode still has it or can't say", async () => {
    const s = setup();
    await s.run([raw("ses_a"), raw("ses_b")]);
    s.lookup.mockImplementation(async (id) =>
      id === "ses_a" ? "alive" : "unknown"
    );
    await s.run([]);
    expect(
      s.tasks.listForProject(project.id).map((t) => t.state)
    ).toStrictEqual(["running", "running"]);
  });

  it("only touches the listed environment's variants", async () => {
    const s = setup();
    await s.run([raw("ses_a")]);
    await s.run([], "env-other");
    expect(s.lookup).not.toHaveBeenCalled();
    expect(s.tasks.listForProject(project.id)[0].state).toBe("running");
  });
});
