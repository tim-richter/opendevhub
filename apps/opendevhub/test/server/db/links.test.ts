import { describe, expect, it } from "vitest";

import { USER, eventsSince, variantActor } from "../../../src/server/db/events";
import { normalisePullUrl, parsePullUrl } from "../../../src/server/db/links";
import type { Project } from "../../../src/shared/types";
import { memoryStores } from "../../helpers/stores";

const project: Project = {
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
};
const other: Project = {
  devcontainerPath: "/src/api/.devcontainer/devcontainer.json",
  id: "api-def456",
  name: "api",
  path: "/src/api",
};
const T1 = "tsk_01JA0000000000000000000001";
const T2 = "tsk_01JA0000000000000000000002";
const JIRA = "https://jira.example";
const PR = "https://forge.example/o/r/pulls/12";
const WT = "/workspaces/demo.worktrees";

const jira = (key: string, title = "Add login") => ({
  description: "",
  instanceUrl: JIRA,
  key,
  title,
});

const setup = () => {
  const clock = { now: 1000 };
  const s = memoryStores(() => clock.now);
  s.projects.upsertAll([project, other]);
  const since = { id: 0 };
  /** The events written since the last call, as `<verb> <object> <task>`. */
  const events = () => {
    const list = eventsSince(s.db, since.id);
    since.id = list.at(-1)?.id ?? since.id;
    return list.map(
      (e) => `${e.verb} ${e.object.type}${e.taskId ? ` ${e.taskId}` : ""}`
    );
  };
  return { ...s, clock, events };
};

describe("normalisePullUrl", () => {
  it("drops the fragment, credentials and trailing slashes", () => {
    expect(normalisePullUrl(" https://forge.example/o/r/pulls/12/#c3 ")).toBe(
      PR
    );
    expect(normalisePullUrl("https://me:pw@forge.example/o/r/pulls/12")).toBe(
      PR
    );
  });

  it("rejects what isn't a web URL", () => {
    expect(() => normalisePullUrl("ssh://forge.example/o/r")).toThrow(
      /not a web URL/u
    );
    expect(() => normalisePullUrl("pulls/12")).toThrow();
  });
});

describe("parsePullUrl", () => {
  it("reads Forgejo/Gitea, GitHub and GitLab URLs", () => {
    expect(parsePullUrl(PR)).toStrictEqual({
      forge: "forgejo",
      number: 12,
      owner: "o",
      repo: "r",
    });
    expect(parsePullUrl("https://github.com/o/r/pull/7")).toStrictEqual({
      forge: "github",
      number: 7,
      owner: "o",
      repo: "r",
    });
    expect(
      parsePullUrl("https://gitlab.com/group/sub/r/-/merge_requests/3/")
    ).toStrictEqual({
      forge: "gitlab",
      number: 3,
      owner: "group/sub",
      repo: "r",
    });
  });

  it("knows nothing about other URLs", () => {
    expect(parsePullUrl("https://forge.example/o/r/compare/main")).toBe(
      undefined
    );
    expect(parsePullUrl("not a url")).toBe(undefined);
  });
});

describe("LinkStore pull requests", () => {
  it("keys rows by the normalised URL and fills what the URL says", () => {
    const { links } = setup();
    const a = links.ensurePull("https://github.com/o/r/pull/7/");
    const b = links.ensurePull("https://github.com/o/r/pull/7#top");
    expect(b.id).toBe(a.id);
    expect(a).toStrictEqual({
      forge: "github",
      id: a.id,
      number: 7,
      owner: "o",
      repo: "r",
      url: "https://github.com/o/r/pull/7",
    });
  });

  it("keeps a known forge over a guess from the URL", () => {
    const { links } = setup();
    links.ensurePull(PR, { forge: "gitea" });
    expect(links.ensurePull(PR).forge).toBe("gitea");
    expect(links.ensurePull(PR, { forge: "forgejo" }).forge).toBe("forgejo");
  });

  it("refreshes a known row's snapshot without an event, and ignores unknown ones", () => {
    const { links, events, clock } = setup();
    links.ensurePull(PR);
    events();
    clock.now = 5000;
    expect(
      links.refreshPull(`${PR}/`, {
        baseBranch: "main",
        headBranch: "feature",
        state: "merged",
        title: "Add login",
      })
    ).toBe(true);
    expect(links.pull(PR)).toMatchObject({
      baseBranch: "main",
      fetchedAt: 5000,
      headBranch: "feature",
      state: "merged",
      title: "Add login",
    });
    expect(links.refreshPull("https://forge.example/o/r/pulls/99", {})).toBe(
      false
    );
    expect(links.pull("https://forge.example/o/r/pulls/99")).toBe(undefined);
    expect(events()).toStrictEqual([]);
  });

  it("links one row from two branches, with an event only when the link is new", () => {
    const { links, checkouts, events } = setup();
    const pull = links.ensurePull(PR);
    const a = checkouts.ensureBranch(project.id, "a", { by: "manual" }, USER);
    const b = checkouts.ensureBranch(project.id, "b", { by: "manual" }, USER);
    events();
    expect(links.linkBranch(a.id, pull.id, "head", USER)).toBe(true);
    expect(links.linkBranch(a.id, pull.id, "head", USER)).toBe(false);
    expect(links.linkBranch(b.id, pull.id, "checkout", USER)).toBe(true);
    expect(events()).toStrictEqual([
      "pull_request.linked pull_request",
      "pull_request.linked pull_request",
    ]);
    expect(checkouts.branch(project.id, "a")?.prUrl).toBe(PR);
    expect(checkouts.branch(project.id, "b")?.originUrl).toBe(PR);
  });
});

describe("LinkStore lookups", () => {
  it("returns empty results for unknown pull requests and tickets", () => {
    const { links } = setup();
    expect(links.forPull(PR)).toStrictEqual({
      branches: [],
      reviewTasks: [],
      reviews: [],
    });
    expect(links.forPull("not a url").branches).toStrictEqual([]);
    expect(links.forTicket(JIRA, "APP-1")).toStrictEqual({ tasks: [] });
    expect(links.reviewsOf(PR)).toStrictEqual([]);
  });

  it("finds a task's published pull request from the PR and from its ticket", () => {
    const { links, checkouts, tasks, clock } = setup();
    tasks.createTask({
      createdAt: 1000,
      id: T1,
      jira: jira("APP-42"),
      projectId: project.id,
      prompt: "Add login",
      title: "Add login",
      variants: [{}, {}],
    });
    checkouts.recordCreated(
      project.id,
      { branch: "task/add-login-2", path: `${WT}/task-add-login-2` },
      { by: "variant", n: 2, task: T1 },
      variantActor(T1, 2)
    );
    clock.now = 2000;
    checkouts.updateBranch(
      project.id,
      "task/add-login-2",
      { pull: { url: PR }, publishedRemote: "origin" },
      USER
    );
    // A second task from the same ticket, in another project, never published.
    tasks.createTask({
      createdAt: 3000,
      id: T2,
      jira: { ...jira("APP-42"), instanceUrl: `${JIRA}/` },
      projectId: other.id,
      prompt: "Add login",
      title: "Add login (api)",
      variants: [{}],
    });
    tasks.archive(T2);

    const byPull = links.forPull(PR);
    expect(byPull.pull).toMatchObject({
      forge: "forgejo",
      number: 12,
      url: PR,
    });
    expect(byPull.branches).toStrictEqual([
      {
        id: checkouts.branch(project.id, "task/add-login-2")?.id,
        name: "task/add-login-2",
        projectId: project.id,
        role: "head",
        task: { id: T1, n: 2, title: "Add login" },
        worktrees: [{ path: `${WT}/task-add-login-2` }],
      },
    ]);

    const byTicket = links.forTicket(JIRA, "APP-42");
    expect(byTicket.ticket).toMatchObject({
      key: "APP-42",
      title: "Add login",
      url: `${JIRA}/browse/APP-42`,
    });
    expect(
      byTicket.tasks.map((t) => [
        t.id,
        t.projectId,
        t.archived ?? false,
        t.pullRequests.map((p) => [p.variant, p.url]),
      ])
    ).toStrictEqual([
      [T2, other.id, true, []],
      [T1, project.id, false, [[2, PR]]],
    ]);

    const snapshot = links.taskLinks(project.id).get(T1);
    expect(snapshot?.ticket?.key).toBe("APP-42");
    expect(snapshot?.pullRequests?.map((p) => p.variant)).toStrictEqual([2]);
  });

  it("refreshes a ticket's title and status, and the task keeps its snapshot", () => {
    const { links, tasks, events } = setup();
    tasks.createTask({
      createdAt: 1000,
      id: T1,
      jira: jira("APP-42"),
      projectId: project.id,
      prompt: "Add login",
      title: "Add login",
      variants: [{}],
    });
    events();
    expect(
      links.refreshTicket(JIRA, "APP-42", {
        status: "In Review",
        title: "Add login with SSO",
      })
    ).toBe(true);
    expect(links.refreshTicket(JIRA, "APP-1", { status: "Done" })).toBe(false);
    expect(links.ticket(JIRA, "APP-1")).toBe(undefined);
    expect(links.ticket(JIRA, "APP-42")).toMatchObject({
      status: "In Review",
      title: "Add login with SSO",
    });
    expect(tasks.get(T1)?.jira?.title).toBe("Add login");
    expect(events()).toStrictEqual([]);
  });
});

describe("LinkStore reviews", () => {
  it("stores review runs with a review.run event and lists them newest first", () => {
    const { links, tasks, events, clock } = setup();
    const pull = links.ensurePull(PR);
    const task = tasks.startManual({
      createdAt: 1000,
      directory: "/w",
      envId: project.id,
      projectId: project.id,
      reviewOf: pull.id,
      sessionId: "ses_1",
      title: "AI review: PR #12",
    });
    expect(tasks.get(task)?.kind).toBe("review");
    events();
    links.insertReview(
      {
        findings: [
          { body: "Off by one", file: "a.ts", line: 3, severity: "major" },
        ],
        headSha: "abc123",
        mode: "session",
        pullRequestId: pull.id,
        sessionId: "ses_1",
        summary: "One bug",
        taskId: task,
      },
      USER
    );
    clock.now = 2000;
    links.insertReview(
      {
        findings: [],
        headSha: "def456",
        mode: "quick",
        pullRequestId: pull.id,
        summary: "Fine",
      },
      USER
    );
    expect(events()).toStrictEqual([
      `review.run review ${task}`,
      "review.run review",
    ]);
    const reviews = links.reviewsOf(PR);
    expect(reviews.map((r) => [r.headSha, r.findings.length])).toStrictEqual([
      ["def456", 0],
      ["abc123", 1],
    ]);
    expect(reviews[1]).toMatchObject({
      mode: "session",
      sessionId: "ses_1",
      summary: "One bug",
      taskId: task,
    });
    expect(links.forPull(PR).reviewTasks.map((t) => t.id)).toStrictEqual([
      task,
    ]);
    expect(links.taskLinks(project.id).get(task)?.reviewOf?.url).toBe(PR);
  });
});
