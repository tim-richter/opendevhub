import { describe, expect, it } from "vitest";

import type {
  DashboardSnapshot,
  EnvironmentView,
  ProjectView,
  PublicRuntime,
  SessionStatus,
} from "../../src/shared/types";
import {
  allSessions,
  attentionCounts,
  compareSessions,
  envOfDirectory,
  envTone,
  openUrlOf,
  sessionHref,
  sshAgentBadge,
  staleNotificationTags,
  matches,
  projectCounts,
  projectTone,
  relativeTime,
  containerShellCommand,
  shellQuote,
  workspaceFolderOf,
  worktreeLabel,
} from "../../src/web/derive";

function snap(statuses: Record<string, SessionStatus>): DashboardSnapshot {
  return {
    roots: [],
    preflight: { errors: [] },
    editors: [],
    projects: [
      {
        tasks: [],
        project: {
          id: "p",
          name: "demo",
          path: "/p",
          devcontainerPath: "/p/x",
        },
        runtime: {
          projectId: "p",
          containerState: "running",
          opencode: "healthy",
        },
        openUrl: "http://p.localhost:7777/",
        environments: [],
        sessions: Object.entries(statuses).map(([id, status]) => ({
          id,
          projectId: "p",
          title: `T ${id}`,
          directory: "/w",
          updatedAt: 1,
          status,
        })),
      },
    ],
  };
}

describe(attentionCounts, () => {
  it("counts sessions needing attention and running", () => {
    expect(
      attentionCounts(
        snap({
          a: "needs-permission",
          b: "needs-answer",
          c: "running",
          d: "idle",
        })
      )
    ).toStrictEqual({
      attention: 2,
      running: 1,
    });
  });
});

describe(relativeTime, () => {
  const now = 1_000_000_000;

  it.each([
    [now - 10_000, "just now"],
    [now - 5 * 60_000, "5 min ago"],
    [now - 3 * 3_600_000, "3 h ago"],
    [now - 2 * 86_400_000, "2 d ago"],
    [now + 5000, "just now"],
  ])("%d", (ts, expected) => expect(relativeTime(ts, now)).toBe(expected));
});

describe("session ordering", () => {
  it("puts attention first, then running, then idle, newest first within a group", () => {
    const s = snap({ a: "idle", b: "running", c: "needs-answer", d: "idle" });
    s.projects[0]!.sessions.find((x) => x.id === "d")!.updatedAt = 5;
    expect(allSessions(s).map((e) => e.session.id)).toStrictEqual([
      "c",
      "b",
      "d",
      "a",
    ]);
    expect([...s.projects[0]!.sessions].sort(compareSessions)[0]!.id).toBe("c");
  });
});

describe("projectCounts / projectTone", () => {
  it("counts sessions by bucket and only forwarded ports", () => {
    const s = snap({
      a: "needs-permission",
      b: "running",
      c: "idle",
      d: "idle",
    });
    s.projects[0]!.runtime.ports = [
      { status: "forwarded", containerPort: 3000, hostPort: 3000 },
      { status: "failed", containerPort: 4000, reason: "x" },
    ];
    expect(projectCounts(s.projects[0]!)).toStrictEqual({
      attention: 1,
      running: 1,
      idle: 2,
      ports: 1,
    });
  });

  it("lets the worst signal win", () => {
    const view = snap({ a: "running" }).projects[0]!;
    expect(projectTone(view)).toBe("running");
    expect(projectTone({ ...view, sessions: [] })).toBe("ok");
    expect(
      projectTone({
        ...view,
        runtime: { ...view.runtime, opencode: "unhealthy" },
      })
    ).toBe("error");
    expect(projectTone(snap({ a: "needs-answer" }).projects[0]!)).toBe(
      "attention"
    );
    expect(
      projectTone({
        ...view,
        sessions: [],
        runtime: {
          projectId: "p",
          containerState: "stopped",
          opencode: "absent",
        },
      })
    ).toBe("off");
  });
});

describe(matches, () => {
  it("matches case-insensitively on any field and treats blank queries as a match", () => {
    expect(matches("", "x")).toBeTruthy();
    expect(matches("API", "my-api")).toBeTruthy();
    expect(matches("nope", "my-api")).toBeFalsy();
  });
});

describe("worktree helpers", () => {
  const view = (
    runtime: Partial<ProjectView["runtime"]> = {}
  ): ProjectView => ({
    tasks: [],
    project: {
      id: "demo-1",
      name: "demo",
      path: "/src/demo",
      devcontainerPath: "/x",
    },
    runtime: {
      projectId: "demo-1",
      containerState: "running",
      opencode: "healthy",
      ...runtime,
    },
    sessions: [],
    openUrl: "http://demo-1.localhost:7777/",
    environments: [],
  });

  it("falls back to /workspaces/<name> before the first start", () => {
    expect(workspaceFolderOf(view())).toBe("/workspaces/demo");
    expect(workspaceFolderOf(view({ workspaceFolder: "/code/demo" }))).toBe(
      "/code/demo"
    );
  });

  it("labels worktree sessions by branch, else by folder", () => {
    const v = view({
      worktrees: [
        { path: "/workspaces/demo.worktrees/feature-x", branch: "feature/x" },
      ],
    });
    expect(worktreeLabel(v, "/workspaces/demo")).toBeUndefined();
    expect(worktreeLabel(v, "/workspaces/demo.worktrees/feature-x")).toBe(
      "feature/x"
    );
    expect(
      worktreeLabel(v, "/home/node/.local/share/opencode/worktree/p/y")
    ).toBe("y");
  });

  it("quotes only what needs quoting", () => {
    expect(shellQuote("/src/demo.worktrees/feature-x")).toBe(
      "/src/demo.worktrees/feature-x"
    );
    expect(shellQuote("/my dir/it's")).toBe(`'/my dir/it'\\''s'`);
  });

  it("builds a docker exec into the checkout as the remote user", () => {
    expect(containerShellCommand(view(), "/w")).toBeUndefined();
    expect(
      containerShellCommand(
        view({ containerName: "demo_c1", remoteUser: "node" }),
        "/workspaces/demo"
      )
    ).toBe(
      "docker exec -it -u node -w /workspaces/demo demo_c1 sh -c 'command -v bash >/dev/null && exec bash -l || exec sh -l'"
    );
  });
});

describe(staleNotificationTags, () => {
  const pending = () => {
    const next = snap({ a: "needs-permission" });
    next.projects[0].sessions[0].pending = {
      permissions: [
        { id: "r1", sessionId: "a", action: "bash", resources: [] },
      ],
      forms: [{ id: "f1", sessionId: "a", title: "Which DB?", fields: [] }],
    };
    return next;
  };

  it("closes answered permissions and questions, keeps pending ones", () => {
    expect(
      staleNotificationTags(pending(), [
        "perm:r1",
        "perm:r0",
        "form:f1",
        "form:f0",
      ])
    ).toStrictEqual(["perm:r0", "form:f0"]);
    expect(
      staleNotificationTags(snap({ a: "idle" }), ["perm:r1", "form:f1"])
    ).toStrictEqual(["perm:r1", "form:f1"]);
  });

  it("never closes finished, test or failure notifications", () => {
    expect(
      staleNotificationTags(snap({}), ["done:a", "test", "perm:r1:failed", ""])
    ).toStrictEqual([]);
  });
});

describe("task environments", () => {
  const env: EnvironmentView = {
    id: "p-feat-0a1b",
    worktree: {
      path: "/w.worktrees/feat",
      hostPath: "/p.worktrees/feat",
      branch: "feat",
    },
    runtime: {
      projectId: "p",
      containerState: "running",
      opencode: "healthy",
      containerName: "task_c",
      remoteUser: "node",
    },
    openUrl: "http://p-feat-0a1b.localhost:7777/",
  };
  const view = (): ProjectView => ({
    ...snap({}).projects[0],
    environments: [env],
  });

  it("finds a checkout's environment and its opencode URL", () => {
    expect(envOfDirectory(view(), "/w.worktrees/feat")?.id).toBe(env.id);
    expect(envOfDirectory(view(), "/w")).toBeUndefined();
    expect(openUrlOf(view(), env.id)).toBe(env.openUrl);
    expect(openUrlOf(view(), undefined)).toBe("http://p.localhost:7777/");
    expect(openUrlOf(view(), "gone")).toBe("http://p.localhost:7777/");
  });

  it("links a session to the opencode that runs it", () => {
    const s = {
      id: "ses_1",
      projectId: "p",
      envId: env.id,
      title: "t",
      directory: "/w.worktrees/feat",
      updatedAt: 1,
      status: "idle" as const,
    };
    expect(sessionHref(view(), s)).toMatch(
      /^http:\/\/p-feat-0a1b\.localhost:7777\/server\/.+\/session\/ses_1$/u
    );
    expect(sessionHref(view(), { ...s, envId: undefined })).toMatch(
      /^http:\/\/p\.localhost:7777\//u
    );
  });

  it("opens a shell in the worktree's own container", () => {
    expect(containerShellCommand(view(), "/w.worktrees/feat")).toContain(
      " task_c "
    );
  });

  it("tones a container by its state", () => {
    expect(envTone(env)).toBe("ok");
    expect(
      envTone({
        ...env,
        runtime: { ...env.runtime, containerState: "starting" },
      })
    ).toBe("busy");
    expect(
      envTone({ ...env, runtime: { ...env.runtime, opencode: "unhealthy" } })
    ).toBe("error");
    expect(
      envTone({
        ...env,
        runtime: { ...env.runtime, containerState: "stopped" },
      })
    ).toBe("off");
  });
});

describe(sshAgentBadge, () => {
  const rt = (patch: Partial<PublicRuntime>): PublicRuntime => ({
    projectId: "p",
    containerState: "running",
    opencode: "healthy",
    ...patch,
  });

  it("shows a forwarded agent quietly and an unavailable one as a warning with its reason", () => {
    expect(sshAgentBadge(rt({ sshAgent: "forwarded" }))).toMatchObject({
      label: "ssh-agent forwarded",
      warn: false,
    });
    expect(
      sshAgentBadge(
        rt({ sshAgent: "unavailable", sshAgentReason: "relay not running" })
      )
    ).toStrictEqual({
      label: "ssh-agent unavailable",
      warn: true,
      title: "relay not running",
    });
  });

  it("warns when the forwarded agent holds no keys", () => {
    expect(
      sshAgentBadge(
        rt({ sshAgent: "forwarded", sshAgentReason: "holds no keys" })
      )
    ).toStrictEqual({
      label: "ssh-agent has no keys",
      warn: true,
      title: "holds no keys",
    });
  });

  it("shows nothing when off, unknown or the container isn't running", () => {
    expect(sshAgentBadge(rt({ sshAgent: "off" }))).toBeUndefined();
    expect(sshAgentBadge(rt({}))).toBeUndefined();
    expect(
      sshAgentBadge(rt({ containerState: "stopped", sshAgent: "forwarded" }))
    ).toBeUndefined();
  });
});
