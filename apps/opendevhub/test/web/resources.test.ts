import { describe, expect, it } from "vitest";

import type {
  DashboardSnapshot,
  EnvironmentView,
  ProjectView,
  ResourceStats,
} from "../../src/shared/types";
import { checkouts } from "../../src/web/checkouts";
import {
  checkoutResources,
  formatCpu,
  formatMemory,
  projectResources,
} from "../../src/web/resources";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const stats = (cpu: number, memory: number): ResourceStats => ({
  cpu,
  memory,
  memoryLimit: 8 * GiB,
});

const env = (id: string, path: string): EnvironmentView =>
  ({
    id,
    worktree: { path, hostPath: `/h${path}`, branch: id },
    runtime: { projectId: "p", containerState: "running", opencode: "healthy" },
    openUrl: `http://${id}`,
  }) as EnvironmentView;

const view: ProjectView = {
  project: {
    id: "p",
    name: "demo",
    path: "/src/demo",
    devcontainerPath: "/src/demo/x",
  },
  runtime: {
    projectId: "p",
    containerState: "running",
    opencode: "healthy",
    workspaceFolder: "/workspaces/demo",
    worktrees: [
      { path: "/workspaces/demo.worktrees/own", branch: "own" },
      { path: "/workspaces/demo.worktrees/shared", branch: "shared" },
    ],
  },
  sessions: [],
  openUrl: "http://p",
  environments: [
    env("env-own", "/workspaces/demo.worktrees/own"),
    env("env-off", "/elsewhere"),
  ],
};

const snap = (
  resources?: DashboardSnapshot["resources"]
): DashboardSnapshot => ({
  roots: [],
  preflight: { errors: [] },
  editors: [],
  projects: [view],
  ...(resources ? { resources } : {}),
});

describe("formatting", () => {
  it("shows CPU as docker does", () => {
    expect(formatCpu(0)).toBe("0%");
    expect(formatCpu(153)).toBe("153%");
  });

  it("shows MiB below a GiB and GiB with one decimal above", () => {
    expect(formatMemory(0)).toBe("0 MiB");
    expect(formatMemory(512 * MiB)).toBe("512 MiB");
    expect(formatMemory(1023 * MiB)).toBe("1023 MiB");
    expect(formatMemory(GiB)).toBe("1.0 GiB");
    expect(formatMemory(1.248 * GiB)).toBe("1.2 GiB");
    expect(formatMemory(31.24 * GiB)).toBe("31.2 GiB");
  });
});

describe(projectResources, () => {
  it("sums the main and task environments that have stats", () => {
    const r = projectResources(
      snap({
        p: stats(10, GiB),
        "env-own": stats(5, 512 * MiB),
        other: stats(99, GiB),
      }),
      view
    );
    expect(r).toStrictEqual({ cpu: 15, memory: GiB + 512 * MiB, count: 2 });
  });

  it("counts task environments when the main one is stopped", () => {
    expect(
      projectResources(snap({ "env-off": stats(3, MiB) }), view)
    ).toStrictEqual({
      cpu: 3,
      memory: MiB,
      count: 1,
    });
  });

  it("is undefined without stats", () => {
    expect(projectResources(snap(), view)).toBeUndefined();
    expect(projectResources(undefined, view)).toBeUndefined();
    expect(
      projectResources(snap({ other: stats(1, 1) }), view)
    ).toBeUndefined();
  });
});

describe(checkoutResources, () => {
  const s = snap({ p: stats(10, GiB), "env-own": stats(5, MiB) });
  const [main, own, shared] = checkouts(view);

  it("gives the main checkout the main container's numbers", () => {
    expect(checkoutResources(s, view, main)).toStrictEqual(stats(10, GiB));
  });

  it("gives a worktree with its own container that container's numbers", () => {
    expect(checkoutResources(s, view, own)).toStrictEqual(stats(5, MiB));
  });

  it("gives a worktree sharing the main container nothing", () => {
    expect(checkoutResources(s, view, shared)).toBeUndefined();
  });
});
