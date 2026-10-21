import { describe, expect, it, vi } from "vitest";

import { SYSTEM } from "../../../src/server/db/events";
import type {
  OpencodeClient,
  RawSession,
} from "../../../src/server/opencode/client";
import { ArchiveSync } from "../../../src/server/sessions/archive-sync";
import type { Project, ProjectRuntime } from "../../../src/shared/types";
import { memoryStores } from "../../helpers/stores";

const project: Project = {
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
};
const WS = "/workspaces/demo";

const raw = (id: string, over: Partial<RawSession> = {}): RawSession => ({
  id,
  location: { directory: WS },
  time: { created: 100, updated: 200 },
  ...over,
});

const setup = (version = "2.1.0") => {
  const s = memoryStores(() => 1000);
  s.projects.upsertAll([project]);
  const runtime: Partial<ProjectRuntime> = {
    containerState: "running",
    opencodeVersion: version,
  };
  const setArchived = vi.fn(
    async (_id: string, _archived: boolean, _dir?: string) => {}
  );
  const log = vi.fn((_env: string, _line: string) => {});
  const sync = new ArchiveSync({
    chats: s.chats,
    clientOf: () => ({ setArchived }) as unknown as OpencodeClient,
    log,
    store: { runtime: () => runtime as ProjectRuntime },
    tasks: s.tasks,
  });
  const chat = (sessionId: string) =>
    s.chats.insert({
      createdAt: 1,
      directory: WS,
      envId: project.id,
      origin: "hub",
      projectId: project.id,
      sessionId,
      step: "session",
      title: sessionId,
    });
  return { ...s, chat, log, runtime, setArchived, sync };
};

describe(ArchiveSync, () => {
  it("archives and unarchives on opencode 2.1", async () => {
    const { sync, setArchived } = setup();
    await sync.archive(project.id, [{ directory: WS, sessionId: "ses_a" }]);
    await sync.unarchive(project.id, [{ sessionId: "ses_b" }]);
    expect(setArchived.mock.calls).toStrictEqual([
      ["ses_a", true, WS],
      ["ses_b", false, undefined],
    ]);
  });

  it("sends nothing on opencode 2.0.x, an unknown version or a stopped container", async () => {
    const { sync, setArchived, runtime, chat, chats } = setup("2.0.32");
    chats.archive(chat("ses_a").id);
    await sync.archive(project.id, [{ sessionId: "ses_a" }]);
    await sync.catchUp(project.id, [raw("ses_a")]);
    runtime.opencodeVersion = undefined;
    await sync.archive(project.id, [{ sessionId: "ses_a" }]);
    runtime.opencodeVersion = "2.1.0";
    runtime.containerState = "stopped";
    await sync.archive(project.id, [{ sessionId: "ses_a" }]);
    expect(setArchived).not.toHaveBeenCalled();
  });

  it("logs a failure instead of throwing", async () => {
    const { sync, setArchived, log } = setup();
    setArchived.mockRejectedValueOnce(new Error("boom"));
    await expect(
      sync.archive(project.id, [{ sessionId: "ses_a" }])
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      project.id,
      "opencode: could not archive session ses_a: boom"
    );
  });

  it("catches up on an archived chat's session once, and leaves others alone", async () => {
    const { sync, setArchived, log, chat, chats, tasks } = setup();
    chats.archive(chat("ses_chat").id);
    chat("ses_live");
    tasks.createTask({
      createdAt: 1,
      id: "tsk_1",
      projectId: project.id,
      prompt: "Fix",
      title: "Fix",
      variants: [{}],
    });
    tasks.attachSession(
      "tsk_1",
      1,
      { directory: WS, envId: project.id, sessionId: "ses_closed" },
      SYSTEM
    );
    tasks.archiveSession("ses_closed");
    const listed = [
      raw("ses_chat"),
      raw("ses_closed"),
      // Archived in opencode's TUI while live here: never unarchived.
      raw("ses_live", { time: { archived: 150, created: 100, updated: 200 } }),
      raw("ses_untracked"),
      raw("ses_agent", { parentID: "ses_chat" }),
    ];
    await sync.catchUp(project.id, listed);
    expect(setArchived.mock.calls).toStrictEqual([
      ["ses_chat", true, WS],
      ["ses_closed", true, WS],
    ]);
    expect(log).toHaveBeenCalledWith(
      project.id,
      "opencode: caught up: archived session ses_chat"
    );
    // Unarchived again in opencode: tried once this run already.
    await sync.catchUp(project.id, listed);
    expect(setArchived).toHaveBeenCalledTimes(2);
  });

  it("knows which sessions opendevhub has archived", () => {
    const { sync, chat, chats } = setup();
    chats.archive(chat("ses_a").id);
    chat("ses_b");
    expect(sync.expectsArchived("ses_a")).toBe(true);
    expect(sync.expectsArchived("ses_b")).toBe(false);
    expect(sync.expectsArchived("ses_none")).toBe(false);
  });
});
