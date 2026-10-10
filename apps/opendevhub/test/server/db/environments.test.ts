import { describe, expect, it } from "vitest";

import { eventsSince, USER, variantActor } from "../../../src/server/db/events";
import { StateStore } from "../../../src/server/projects/state";
import type { Project } from "../../../src/shared/types";
import { memoryStores, stateStores, worktreeRow } from "../../helpers/stores";

const project: Project = {
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
};
const T1 = "tsk_01JA0000000000000000000001";
const feat = {
  branch: "feat",
  hostPath: "/src/demo.worktrees/feat",
  path: "/workspaces/demo.worktrees/feat",
};

const setup = () => {
  const clock = { now: 1000 };
  const s = memoryStores(() => clock.now);
  s.projects.upsertAll([project]);
  const since = { id: 0 };
  /** The environment events written since the last call, as `<verb> <object> <task>`. */
  const events = () => {
    const list = eventsSince(s.db, since.id);
    since.id = list.at(-1)?.id ?? since.id;
    return list
      .filter((e) => e.object.type === "environment")
      .map((e) => `${e.verb} ${e.object.id} ${e.taskId ?? "-"}`);
  };
  events();
  const worktreeId = worktreeRow(s, project.id, feat);
  return { ...s, clock, events, worktreeId };
};

describe("EnvironmentStore", () => {
  it("gives every discovered project a main environment without a worktree", () => {
    const s = setup();
    expect(s.environments.listLive()).toStrictEqual([
      {
        createdAt: 1000,
        id: project.id,
        kind: "main",
        projectId: project.id,
        runtime: {},
      },
    ]);
    s.environments.putMain(project.id);
    expect(s.events()).toStrictEqual([]);
  });

  it("records a task environment on its worktree row, with an event carrying the task", () => {
    const s = setup();
    const row = s.environments.putTask(
      {
        id: "env-feat",
        node: "box",
        projectId: project.id,
        worktreeId: s.worktreeId,
      },
      variantActor(T1, 2),
      T1
    );
    expect(row).toStrictEqual({
      createdAt: 1000,
      id: "env-feat",
      kind: "task",
      node: "box",
      projectId: project.id,
      runtime: {},
      worktree: feat,
      worktreeId: s.worktreeId,
    });
    // Recording it again changes nothing.
    s.environments.putTask(
      { id: "env-feat", projectId: project.id, worktreeId: s.worktreeId },
      USER
    );
    expect(s.events()).toStrictEqual([`environment.created env-feat ${T1}`]);
    const [event] = eventsSince(s.db).filter((e) => e.object.id === "env-feat");
    expect(event.actor).toStrictEqual(variantActor(T1, 2));
  });

  it("writes durable fields and the image without an event, and clears a field set to undefined", () => {
    const s = setup();
    s.environments.updateDurable(project.id, {
      containerId: "c1",
      password: "pw",
      relayToken: "tok",
      remoteUser: "node",
      workspaceFolder: "/workspaces/demo",
    });
    s.environments.updateDurable(project.id, {
      containerId: "c2",
      image: { key: "k", ref: "r" },
      remoteUser: undefined,
    });
    expect(s.environments.get(project.id)).toMatchObject({
      image: { key: "k", ref: "r" },
      runtime: {
        containerId: "c2",
        password: "pw",
        relayToken: "tok",
        workspaceFolder: "/workspaces/demo",
      },
    });
    expect(s.environments.get(project.id)?.runtime).not.toHaveProperty(
      "remoteUser"
    );
    expect(s.events()).toStrictEqual([]);
  });

  it("marks an environment removed once, drops its secrets and names the task of its variant", () => {
    const s = setup();
    s.tasks.createTask({
      createdAt: 1000,
      id: T1,
      projectId: project.id,
      prompt: "Fix",
      title: "Fix",
      variants: [{}],
    });
    s.environments.putTask(
      { id: "env-feat", projectId: project.id, worktreeId: s.worktreeId },
      USER
    );
    s.environments.updateDurable("env-feat", {
      containerId: "c",
      password: "pw",
    });
    s.tasks.updateVariant(T1, 1, { envId: "env-feat" }, variantActor(T1, 1));
    s.events();
    s.clock.now = 2000;
    expect(s.environments.markRemoved("env-feat", USER)).toBeTruthy();
    expect(s.environments.markRemoved("env-feat", USER)).toBeFalsy();
    expect(s.environments.get("env-feat")).toMatchObject({
      removedAt: 2000,
      runtime: { containerId: "c" },
    });
    expect(s.environments.get("env-feat")?.runtime).not.toHaveProperty(
      "password"
    );
    expect(s.environments.listLive().map((e) => e.id)).toStrictEqual([
      project.id,
    ]);
    expect(s.events()).toStrictEqual([`environment.removed env-feat ${T1}`]);
  });

  it("makes a removed environment anew when its worktree gets a container again", () => {
    const s = setup();
    const env = {
      id: "env-feat",
      projectId: project.id,
      worktreeId: s.worktreeId,
    };
    s.environments.putTask(env, USER);
    s.environments.updateDurable("env-feat", { containerId: "old" });
    s.environments.markRemoved("env-feat", USER);
    s.clock.now = 3000;
    expect(s.environments.putTask(env, USER)).toMatchObject({
      createdAt: 3000,
      runtime: {},
    });
    expect(s.environments.get("env-feat")).not.toHaveProperty("removedAt");
    expect(s.events().map((e) => e.split(" ")[0])).toStrictEqual([
      "environment.created",
      "environment.removed",
      "environment.created",
    ]);
  });

  it("counts the live environments on a node", () => {
    const s = setup();
    const remote = worktreeRow(s, project.id, feat, "box");
    s.environments.putTask(
      { id: "env-a", node: "box", projectId: project.id, worktreeId: remote },
      USER
    );
    s.environments.putTask(
      { id: "env-b", projectId: project.id, worktreeId: s.worktreeId },
      USER
    );
    expect(s.environments.countOnNode("box")).toBe(1);
    s.environments.markRemoved("env-a", USER);
    expect(s.environments.countOnNode("box")).toBe(0);
  });

  it("refuses a task environment without a worktree, and a variant pointing at an unknown environment", () => {
    const s = setup();
    expect(() =>
      s.db
        .prepare(
          "INSERT INTO environments (id, project_id, kind, created_at) VALUES ('x', ?, 'task', 1)"
        )
        .run(project.id)
    ).toThrow(/CHECK/u);
    s.tasks.createTask({
      createdAt: 1000,
      id: T1,
      projectId: project.id,
      prompt: "Fix",
      title: "Fix",
      variants: [{}],
    });
    expect(() =>
      s.tasks.updateVariant(T1, 1, { envId: "nope" }, variantActor(T1, 1))
    ).toThrow(/FOREIGN KEY/u);
  });

  it("restores runtimes into the state store, keeps secrets out of the snapshot, and writes no event on a runtime update", () => {
    const s = setup();
    s.environments.putTask(
      { id: "env-feat", projectId: project.id, worktreeId: s.worktreeId },
      USER
    );
    s.environments.updateDurable("env-feat", {
      containerId: "c2",
      password: "task-secret",
      relayToken: "relay-secret",
    });
    s.environments.updateDurable(project.id, { password: "main-secret" });
    s.events();
    const store = new StateStore({ ...stateStores(s), port: 7777 });
    store.setProjects([project]);
    expect(store.runtime("env-feat")).toMatchObject({
      containerId: "c2",
      containerState: "stopped",
      password: "task-secret",
    });
    store.updateRuntime("env-feat", { containerId: "c3" });
    expect(s.environments.get("env-feat")?.runtime.containerId).toBe("c3");
    expect(s.events()).toStrictEqual([]);
    const snap = JSON.stringify(store.snapshot());
    for (const secret of ["task-secret", "relay-secret", "main-secret"]) {
      expect(snap).not.toContain(secret);
    }
    expect(store.snapshot().projects[0].environments[0]).toMatchObject({
      id: "env-feat",
      worktreeId: s.worktreeId,
    });
  });
});
