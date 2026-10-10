import { describe, expect, it } from "vitest";

import { USER, eventsSince, variantActor } from "../../../src/server/db/events";
import type { Project } from "../../../src/shared/types";
import { memoryStores } from "../../helpers/stores";

const project: Project = {
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
};
const T1 = "tsk_01JA0000000000000000000001";
const T2 = "tsk_01JA0000000000000000000002";
const WT = "/workspaces/demo.worktrees";

const setup = () => {
  const clock = { now: 1000 };
  const s = memoryStores(() => clock.now);
  s.projects.upsertAll([project]);
  for (const id of [T1, T2]) {
    s.tasks.createTask({
      createdAt: clock.now,
      id,
      projectId: project.id,
      prompt: "Add login",
      title: "Add login",
      variants: [{}, {}],
    });
  }
  const since = { id: 0 };
  /** The events written since the last call, as `<verb> <actor> <data>`. */
  const events = () => {
    const list = eventsSince(s.db, since.id);
    since.id = list.at(-1)?.id ?? since.id;
    return list.map(
      (e) =>
        `${e.verb} ${e.actor.type === "variant" ? e.actor.id : e.actor.type}${e.taskId ? ` ${e.taskId}` : ""}`
    );
  };
  events();
  return { clock, events, ...s };
};

describe("CheckoutStore branches", () => {
  it("keeps the original creator when a branch already has a row", () => {
    const { checkouts, events } = setup();
    const first = checkouts.ensureBranch(
      project.id,
      "task/add-login-2",
      { by: "variant", n: 2, task: T1 },
      variantActor(T1, 2),
      { base: "main" }
    );
    expect(events()).toEqual([`branch.created ${T1}/2 ${T1}`]);
    const again = checkouts.ensureBranch(
      project.id,
      "task/add-login-2",
      { by: "variant", n: 1, task: T2 },
      variantActor(T2, 1)
    );
    expect(again.id).toBe(first.id);
    expect(again.createdBy).toEqual({ by: "variant", n: 2, task: T1 });
    expect(again.base).toBe("main");
    expect(events()).toEqual([]);
  });

  it("links a pull request checkout's branch with role checkout", () => {
    const { checkouts, events } = setup();
    events();
    const { branch } = checkouts.recordCreated(
      project.id,
      {
        branch: "pr-12",
        path: `${WT}/pr-12`,
        pull: { url: "https://forge.example/o/r/pulls/12/" },
      },
      { by: "pull" },
      USER
    );
    expect(branch).toMatchObject({
      createdBy: { by: "pull" },
      originUrl: "https://forge.example/o/r/pulls/12",
      pullRequest: {
        role: "checkout",
        url: "https://forge.example/o/r/pulls/12",
      },
    });
    expect(branch.prUrl).toBeUndefined();
    expect(events()).toEqual([
      "branch.created user",
      "pull_request.linked user",
      "worktree.created user",
    ]);
  });

  it("gives a task's branch its ticket as origin", () => {
    const { checkouts, tasks } = setup();
    tasks.createTask({
      createdAt: 1000,
      id: "tsk_01JA0000000000000000000003",
      jira: {
        description: "",
        instanceUrl: "https://jira.example",
        key: "APP-42",
        title: "Add login",
      },
      projectId: project.id,
      prompt: "Add login",
      title: "Add login",
      variants: [{}],
    });
    const row = checkouts.ensureBranch(
      project.id,
      "task/add-login",
      { by: "variant", n: 1, task: "tsk_01JA0000000000000000000003" },
      USER
    );
    expect(row.originUrl).toBe("https://jira.example/browse/APP-42");
  });

  it("records publishing, creating a row for a branch it didn't know", () => {
    const { checkouts, events } = setup();
    const row = checkouts.updateBranch(
      project.id,
      "feature/x",
      {
        agitTopic: "feature/x",
        pull: { forge: "forgejo", url: "https://forge.example/o/r/pulls/3" },
        publishedAt: 1000,
        publishedRemote: "origin",
      },
      USER
    );
    expect(row).toMatchObject({
      agitTopic: "feature/x",
      createdBy: { by: "unmanaged" },
      prUrl: "https://forge.example/o/r/pulls/3",
      publishedAt: 1000,
      publishedRemote: "origin",
    });
    expect(row.pullRequest?.role).toBe("head");
    expect(events()).toEqual([
      "branch.created user",
      "branch.published user",
      "pull_request.linked user",
    ]);
    checkouts.updateBranch(project.id, "feature/x", { base: "main" }, USER);
    expect(events()).toEqual([]);
    expect(checkouts.branch(project.id, "feature/x")?.base).toBe("main");
  });

  it("marks a deleted branch and makes it anew when the name comes back", () => {
    const { checkouts, events, clock } = setup();
    checkouts.ensureBranch(project.id, "b", { by: "manual" }, USER);
    checkouts.updateBranch(
      project.id,
      "b",
      { pull: { url: "https://forge.example/o/r/pulls/9" } },
      USER
    );
    events();
    expect(checkouts.deleteBranch(project.id, "b", USER)).toBe(true);
    expect(checkouts.deleteBranch(project.id, "b", USER)).toBe(false);
    expect(checkouts.branch(project.id, "b")?.deletedAt).toBe(1000);
    expect(events()).toEqual(["branch.deleted user"]);
    clock.now = 2000;
    const back = checkouts.ensureBranch(
      project.id,
      "b",
      { by: "variant", n: 1, task: T1 },
      variantActor(T1, 1)
    );
    expect(back).toMatchObject({
      createdAt: 2000,
      createdBy: { by: "variant", n: 1, task: T1 },
    });
    expect(back.deletedAt).toBeUndefined();
    expect(back.prUrl).toBeUndefined();
    expect(back.pullRequest).toBeUndefined();
  });
});

describe("CheckoutStore worktrees", () => {
  const created = (
    s: ReturnType<typeof setup>,
    branch = "task/add-login-1"
  ) => {
    const b = s.checkouts.ensureBranch(
      project.id,
      branch,
      { by: "variant", n: 1, task: T1 },
      variantActor(T1, 1)
    );
    return s.checkouts.insertWorktree(
      project.id,
      { branch, branchId: b.id, path: `${WT}/${branch.replaceAll("/", "-")}` },
      { by: "variant", n: 1, task: T1 },
      variantActor(T1, 1)
    );
  };

  it("links the variant to the worktree it created", () => {
    const s = setup();
    const wt = created(s);
    expect(wt.createdBy).toEqual({ by: "variant", n: 1, task: T1 });
    const links = s.checkouts.variantLinks(T1, 1);
    expect(links.worktree?.id).toBe(wt.id);
    expect(links.branch?.name).toBe("task/add-login-1");
    expect(s.events()).toEqual([
      `branch.created ${T1}/1 ${T1}`,
      `worktree.created ${T1}/1 ${T1}`,
    ]);
  });

  it("gives a reused path a new row", () => {
    const s = setup();
    const first = created(s);
    s.checkouts.reconcileWorktrees(project.id, []);
    expect(s.checkouts.worktreesOf(project.id)).toEqual([]);
    const second = created(s);
    expect(second.id).not.toBe(first.id);
    const history = s.checkouts.worktreeHistory(project.id);
    expect(history.map((w) => w.removedAt)).toEqual([1000, undefined]);
  });

  it("adopts a worktree made outside opendevhub as unmanaged", () => {
    const s = setup();
    s.checkouts.reconcileWorktrees(project.id, [
      {
        branch: "spike",
        hostPath: "/src/demo.worktrees/spike",
        path: `${WT}/spike`,
      },
    ]);
    const [wt] = s.checkouts.worktreesOf(project.id);
    expect(wt).toMatchObject({
      branch: "spike",
      createdBy: { by: "unmanaged" },
      hostPath: "/src/demo.worktrees/spike",
    });
    expect(s.checkouts.branch(project.id, "spike")?.createdBy).toEqual({
      by: "unmanaged",
    });
    expect(s.events()).toEqual([
      "branch.created system",
      "worktree.adopted system",
    ]);
  });

  it("finds the rows opendevhub created and adds nothing", () => {
    const s = setup();
    const wt = created(s);
    s.events();
    s.checkouts.reconcileWorktrees(project.id, [
      { branch: "task/add-login-1", path: wt.path },
    ]);
    expect(s.checkouts.worktreesOf(project.id)).toHaveLength(1);
    expect(s.events()).toEqual([]);
  });

  it("follows a branch switch, while the variant keeps its own branch", () => {
    const s = setup();
    const wt = created(s);
    s.events();
    s.checkouts.reconcileWorktrees(project.id, [
      { branch: "other", path: wt.path },
    ]);
    const [now] = s.checkouts.worktreesOf(project.id);
    expect(now).toMatchObject({ branch: "other", id: wt.id });
    expect(s.checkouts.variantLinks(T1, 1).branch?.name).toBe(
      "task/add-login-1"
    );
    expect(s.events()).toEqual([
      "branch.created system",
      `worktree.switched system ${T1}`,
    ]);
    s.checkouts.reconcileWorktrees(project.id, [{ path: wt.path }]);
    expect(s.checkouts.worktreesOf(project.id)[0]?.branchId).toBeUndefined();
  });

  it("marks a worktree removed when the listing no longer has it", () => {
    const s = setup();
    created(s);
    s.events();
    s.checkouts.reconcileWorktrees(project.id, []);
    expect(s.events()).toEqual([`worktree.removed system ${T1}`]);
    s.checkouts.reconcileWorktrees(project.id, []);
    expect(s.events()).toEqual([]);
  });

  it("keeps node worktrees out of this machine's reconcile", () => {
    const s = setup();
    s.checkouts.insertWorktree(
      project.id,
      { branch: "t", node: "builder", path: `${WT}/t` },
      { by: "variant", n: 2, task: T1 },
      variantActor(T1, 2)
    );
    s.checkouts.reconcileWorktrees(project.id, []);
    expect(s.checkouts.worktreesOf(project.id)).toMatchObject([
      { node: "builder" },
    ]);
    expect(
      s.checkouts.removeWorktree(project.id, `${WT}/t`, "builder", USER)
    ).toBe(true);
    expect(s.checkouts.worktreesOf(project.id)).toEqual([]);
  });

  it("records a removal by the user with the task of its variant", () => {
    const s = setup();
    const wt = created(s);
    s.events();
    expect(
      s.checkouts.removeWorktree(project.id, wt.path, undefined, USER)
    ).toBe(true);
    expect(s.events()).toEqual([`worktree.removed user ${T1}`]);
    expect(
      s.checkouts.removeWorktree(project.id, wt.path, undefined, USER)
    ).toBe(false);
  });

  it("lets a creator claim a worktree reconcile adopted first", () => {
    const s = setup();
    s.checkouts.reconcileWorktrees(project.id, [
      { branch: "task/add-login-1", path: `${WT}/task-add-login-1` },
    ]);
    const wt = created(s);
    expect(s.checkouts.worktreesOf(project.id)).toHaveLength(1);
    expect(wt.createdBy).toEqual({ by: "variant", n: 1, task: T1 });
  });

  it("changes nothing when a listing failed (reconcile isn't called)", () => {
    const s = setup();
    created(s);
    s.events();
    expect(s.checkouts.worktreesOf(project.id)).toHaveLength(1);
    expect(s.events()).toEqual([]);
  });

  it("tells subscribers only about changes", () => {
    const s = setup();
    let calls = 0;
    s.checkouts.subscribe(() => {
      calls += 1;
    });
    const wt = created(s);
    const after = calls;
    s.checkouts.reconcileWorktrees(project.id, [
      { branch: "task/add-login-1", path: wt.path },
    ]);
    expect(calls).toBe(after);
  });
});
