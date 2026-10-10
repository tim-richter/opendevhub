import { describe, expect, it } from "vitest";

import { SYSTEM, USER, variantActor } from "../../../src/server/db/events";
import { ProvenanceStore } from "../../../src/server/db/provenance";
import { NotFoundError } from "../../../src/server/errors";
import type { Provenance } from "../../../src/shared/activity";
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
const PR = "https://forge.example/o/r/pulls/12";
const WT = "/workspaces/demo.worktrees";

/** The trail as `type label` lines, removed ones marked `~`, unmanaged ones `?`. */
const lines = (p: Provenance["trail"]) =>
  p.map(
    (s) =>
      `${s.removed ? "~" : ""}${s.unmanaged ? "?" : ""}${s.type} ${s.label}`
  );

/** Task T1 from ticket APP-42 with two variants; variant 2 has a worktree, its own container, a session and a PR. */
const setup = () => {
  const clock = { now: 1000 };
  const s = memoryStores(() => clock.now);
  s.projects.upsertAll([project]);
  s.tasks.createTask({
    createdAt: 1000,
    id: T1,
    jira: {
      description: "",
      instanceUrl: "https://jira.example",
      key: "APP-42",
      title: "Add login",
    },
    projectId: project.id,
    prompt: "Add login",
    title: "Add login",
    variants: [{}, { model: { id: "opus", providerID: "anthropic" } }],
  });
  const { branch, worktree } = s.checkouts.recordCreated(
    project.id,
    { branch: "task/add-login-2", path: `${WT}/task-add-login-2` },
    { by: "variant", n: 2, task: T1 },
    variantActor(T1, 2)
  );
  s.environments.putTask(
    { id: "env-2", projectId: project.id, worktreeId: worktree.id },
    variantActor(T1, 2),
    T1
  );
  s.tasks.attachSession(
    T1,
    2,
    {
      directory: `${WT}/task-add-login-2`,
      envId: "env-2",
      sessionId: "ses_2",
    },
    variantActor(T1, 2)
  );
  s.checkouts.updateBranch(
    project.id,
    "task/add-login-2",
    { pull: { url: PR }, publishedRemote: "origin" },
    USER
  );
  const provenance = new ProvenanceStore(s.db);
  return { ...s, branch, clock, provenance, worktree };
};

describe("ProvenanceStore", () => {
  it("walks a session of a ticket task up to the ticket, and lists the PR it led to", () => {
    const { provenance, links, worktree } = setup();
    const pull = links.pull(PR);
    links.insertReview(
      {
        findings: [],
        headSha: "abc",
        mode: "quick",
        pullRequestId: pull?.id ?? 0,
        summary: "fine",
      },
      USER
    );
    const p = provenance.of("session", "ses_2");
    expect(lines(p.trail)).toStrictEqual([
      "ticket APP-42",
      "task Add login",
      "variant Variant 2 (opus)",
      "branch task/add-login-2",
      "worktree task-add-login-2",
      "environment Container",
      "session Session",
    ]);
    const base = `/p/${project.id}`;
    expect(p.trail.map((s) => s.href)).toStrictEqual([
      "/jira/APP-42",
      `${base}/t/${T1}`,
      `${base}/t/${T1}`,
      `${base}/w/task-add-login-2`,
      `${base}/w/task-add-login-2`,
      `${base}/w/task-add-login-2/runtime`,
      `${base}/w/task-add-login-2/s/ses_2`,
    ]);
    expect(p.trail[4].id).toBe(String(worktree.id));
    expect(lines(p.ledTo)).toStrictEqual([
      "pull_request PR #12",
      "review AI review · 0 findings",
    ]);
    expect(p.ledTo[0]).toMatchObject({
      href: "/forgejo/o/r/12",
      url: PR,
    });
  });

  it("keeps a removed worktree in the trail, flagged and without a link", () => {
    const { provenance, checkouts, environments } = setup();
    environments.markRemoved("env-2", USER);
    checkouts.removeWorktree(
      project.id,
      `${WT}/task-add-login-2`,
      undefined,
      USER
    );
    const p = provenance.of("environment", "env-2");
    expect(lines(p.trail)).toStrictEqual([
      "ticket APP-42",
      "task Add login",
      "variant Variant 2 (opus)",
      "branch task/add-login-2",
      "~worktree task-add-login-2",
      "~environment Container",
    ]);
    expect(p.trail[4].href).toBe(undefined);
    // The branch has no live checkout to link to any more.
    expect(p.trail[3].href).toBe(undefined);
  });

  it("gives an unmanaged worktree only its project", () => {
    const { provenance, checkouts } = setup();
    checkouts.reconcileWorktrees(project.id, [
      { branch: "task/add-login-2", path: `${WT}/task-add-login-2` },
      { branch: "spike", path: `${WT}/spike` },
    ]);
    const spike = checkouts
      .worktreesOf(project.id)
      .find((w) => w.path === `${WT}/spike`);
    const p = provenance.of("worktree", String(spike?.id));
    expect(lines(p.trail)).toStrictEqual(["project demo", "?worktree spike"]);
    expect(p.ledTo).toStrictEqual([]);
  });

  it("walks a pull request, a review task and its review back to the authoring task", () => {
    const { provenance, links, tasks } = setup();
    const pull = links.pull(PR);
    const reviewTask = tasks.startManual({
      createdAt: 2000,
      directory: "/w",
      envId: project.id,
      projectId: project.id,
      reviewOf: pull?.id,
      sessionId: "ses_r",
      title: "AI review: PR #12",
    });
    const review = links.insertReview(
      {
        findings: [{ body: "x", file: "a.ts", line: 1, severity: "minor" }],
        headSha: "abc",
        mode: "session",
        pullRequestId: pull?.id ?? 0,
        sessionId: "ses_r",
        summary: "one",
      },
      USER
    );
    expect(
      lines(provenance.of("pull_request", String(pull?.id)).trail)
    ).toStrictEqual([
      "ticket APP-42",
      "task Add login",
      "variant Variant 2 (opus)",
      "branch task/add-login-2",
      "pull_request PR #12",
    ]);
    const p = provenance.of("review", String(review.id));
    expect(lines(p.trail).slice(-3)).toStrictEqual([
      "pull_request PR #12",
      "task AI review: PR #12",
      "review AI review · 1 finding",
    ]);
    // A review task's session has no variant step.
    expect(
      lines(provenance.of("session", "ses_r").trail).slice(-2)
    ).toStrictEqual(["task AI review: PR #12", "session AI review: PR #12"]);
    expect(lines(provenance.of("task", reviewTask).ledTo)).toStrictEqual([
      "review AI review · 1 finding",
    ]);
  });

  it("starts an implementing task's trail at the task that proposed it, and lists a ticket's tasks", () => {
    const { provenance, tasks, db, links } = setup();
    tasks.createTask({
      createdAt: 3000,
      id: T2,
      projectId: project.id,
      prompt: "Implement",
      title: "Implement login",
      variants: [{}],
    });
    db.prepare("UPDATE tasks SET proposed_in = ? WHERE id = ?").run(T1, T2);
    expect(lines(provenance.of("variant", `${T2}/1`).trail)).toStrictEqual([
      "ticket APP-42",
      "task Add login",
      "task Implement login",
      "variant Variant 1",
    ]);
    const ticket = links.ticket("https://jira.example", "APP-42");
    expect(
      lines(provenance.of("ticket", String(ticket?.id)).ledTo)
    ).toStrictEqual(["task Add login", "pull_request PR #12"]);
  });

  it("marks archived tasks and discarded variants removed, and throws for unknown entities", () => {
    const { provenance, tasks } = setup();
    tasks.pick(T1, 2, USER);
    tasks.archive(T1, SYSTEM);
    const p = provenance.of("variant", `${T1}/1`);
    expect(lines(p.trail)).toStrictEqual([
      "ticket APP-42",
      "~task Add login",
      "~variant Variant 1",
    ]);
    expect(() => provenance.of("session", "nope")).toThrow(NotFoundError);
    expect(() => provenance.of("worktree", "999")).toThrow(NotFoundError);
    expect(() => provenance.of("variant", "garbage")).toThrow(NotFoundError);
  });
});
