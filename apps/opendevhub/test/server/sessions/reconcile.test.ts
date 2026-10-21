import { describe, expect, it, vi } from "vitest";

import { eventsSince, variantActor } from "../../../src/server/db/events";
import type { RawSession } from "../../../src/server/opencode/client";
import { reconcileSessions } from "../../../src/server/sessions/reconcile";
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
  const keptArchived = vi.fn((_id: string) => false);
  const run = (sessions: RawSession[], envId = project.id) =>
    reconcileSessions(s, {
      branchOf: (dir) => (dir === WS ? undefined : "feat"),
      envId,
      keptArchived,
      lookup,
      projectId: project.id,
      sessions,
    });
  const verbs = () => eventsSince(s.db).map((e) => `${e.verb} ${e.object.id}`);
  const chats = () => s.chats.listForProject(project.id);
  return { ...s, chatList: chats, keptArchived, lookup, run, verbs };
};

describe("reconcileSessions", () => {
  it("records top-level sessions no variant owns as chats from opencode, skipping subagents and archived ones", async () => {
    const s = setup();
    await s.run([
      raw("ses_a", { location: { directory: "/w/feat" } }),
      raw("ses_child", { parentID: "ses_a" }),
      raw("ses_old", { time: { archived: 150, created: 1, updated: 2 } }),
    ]);
    const chats = s.chatList();
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({
      branch: "feat",
      createdAt: 100,
      directory: "/w/feat",
      envId: project.id,
      origin: "opencode",
      sessionId: "ses_a",
      step: "session",
      title: "Session ses_a",
    });
    expect(s.chats.hasSession("ses_child")).toBeFalsy();
    expect(s.tasks.listForProject(project.id)).toStrictEqual([]);
    expect(s.verbs().filter((v) => v.startsWith("chat."))).toStrictEqual([
      `chat.discovered ${chats[0].id}`,
    ]);
  });

  it("writes nothing on a second pass with the same sessions", async () => {
    const s = setup();
    await s.run([raw("ses_a")]);
    const before = s.verbs().length;
    await s.run([raw("ses_a")]);
    expect(s.verbs()).toHaveLength(before);
    expect(s.chatList()).toHaveLength(1);
  });

  it("leaves a variant's session in a claimed directory to the variant, which then owns it", async () => {
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
    expect(s.chats.hasSession("ses_t")).toBeFalsy();
    s.tasks.attachSession(
      T1,
      1,
      { directory: WS, envId: project.id, sessionId: "ses_t" },
      variantActor(T1, 1)
    );
    release();
    await s.run([raw("ses_t")]);
    expect(s.tasks.sessionRef("ses_t")?.id).toBe(T1);
    expect(s.chats.hasSession("ses_t")).toBeFalsy();
  });

  it("lets a chat's title follow its session, but never a task's", async () => {
    const s = setup();
    await s.run([raw("ses_a", { title: "" })]);
    expect(s.chatList()[0].title).toBe("Untitled session");
    await s.run([raw("ses_a", { title: "Fix the flaky test" })]);
    expect(s.chatList()[0].title).toBe("Fix the flaky test");
    s.tasks.createTask({
      createdAt: 1,
      id: T1,
      projectId: project.id,
      prompt: "p",
      title: "Fix",
      variants: [{}],
    });
    s.tasks.attachSession(
      T1,
      1,
      { directory: WS, envId: project.id, sessionId: "ses_t" },
      variantActor(T1, 1)
    );
    await s.run([raw("ses_a"), raw("ses_t", { title: "Renamed" })]);
    expect(s.tasks.get(T1)?.title).toBe("Fix");
  });

  it("marks a deleted or archived session removed, and clears it when it is listed again", async () => {
    const s = setup();
    await s.run([raw("ses_a"), raw("ses_b")]);
    await s.run([
      raw("ses_b", { time: { archived: 300, created: 100, updated: 300 } }),
    ]);
    expect(s.lookup).toHaveBeenCalledWith("ses_a");
    expect(s.chats.bySession("ses_a")?.sessionRemoved).toBeTruthy();
    expect(s.chats.bySession("ses_b")?.sessionRemoved).toBeTruthy();
    expect(s.chatList()).toStrictEqual([]);
    await s.run([raw("ses_a")]);
    expect(s.chatList().map((c) => c.sessionId)).toStrictEqual(["ses_a"]);
  });

  it("keeps a session opendevhub archived itself, so cleanup can still delete it", async () => {
    const s = setup();
    await s.run([raw("ses_a")]);
    s.keptArchived.mockImplementation((id) => id === "ses_a");
    await s.run([
      raw("ses_a", { time: { archived: 300, created: 100, updated: 300 } }),
    ]);
    expect(s.lookup).not.toHaveBeenCalled();
    expect(s.chats.bySession("ses_a")?.sessionRemoved).toBeFalsy();
  });

  it("marks a variant's session removed as before", async () => {
    const s = setup();
    s.tasks.createTask({
      createdAt: 1,
      id: T1,
      projectId: project.id,
      prompt: "p",
      title: "Fix",
      variants: [{}],
    });
    s.tasks.attachSession(
      T1,
      1,
      { directory: WS, envId: project.id, sessionId: "ses_t" },
      variantActor(T1, 1)
    );
    await s.run([]);
    expect(s.tasks.get(T1)?.state).toBe("ended");
  });

  it("keeps a session the listing left out when opencode still has it or can't say", async () => {
    const s = setup();
    await s.run([raw("ses_a"), raw("ses_b")]);
    s.lookup.mockImplementation(async (id) =>
      id === "ses_a" ? "alive" : "unknown"
    );
    await s.run([]);
    expect(s.chatList()).toHaveLength(2);
  });

  it("only touches the listed environment's chats", async () => {
    const s = setup();
    await s.run([raw("ses_a")]);
    await s.run([], "env-other");
    expect(s.lookup).not.toHaveBeenCalled();
    expect(s.chatList()).toHaveLength(1);
  });

  it("leaves alone a session attached while opencode was being asked about others", async () => {
    const s = setup();
    s.tasks.createTask({
      createdAt: 1,
      id: T1,
      projectId: project.id,
      prompt: "Fix",
      title: "Fix",
      variants: [{}, {}],
    });
    s.tasks.attachSession(
      T1,
      1,
      { directory: WS, envId: project.id, sessionId: "ses_old" },
      variantActor(T1, 1)
    );
    s.lookup.mockImplementationOnce(async () => {
      // Variant 2's setup attaches its new session meanwhile; the listing predates it.
      s.tasks.attachSession(
        T1,
        2,
        { directory: WS, envId: project.id, sessionId: "ses_new" },
        variantActor(T1, 2)
      );
      return "gone";
    });
    await s.run([]);
    expect(
      s.tasks.get(T1)?.variants.map((v) => v.sessionRemoved)
    ).toStrictEqual([true, undefined]);
  });
});
