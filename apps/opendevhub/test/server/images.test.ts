import { describe, expect, it, vi } from "vitest";
import { Images, baseImageRef, imageKey } from "../../src/server/images";
import type { RunResult } from "../../src/server/exec";
import type { EnvWorktree, Project } from "../../src/shared/types";

const project: Project = { id: "demo-abc123", name: "demo", path: "/src/demo", devcontainerPath: "/x" };
const other: Project = { ...project, id: "other-def456", path: "/src/other" };
const wt = (name: string): EnvWorktree => ({ path: `/workspaces/demo.worktrees/${name}`, hostPath: `/src/demo.worktrees/${name}`, branch: name });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(list: (string | undefined)[] = ["tree1", undefined]) {
  const builds: Array<{ folder: string; ref: string; done: ReturnType<typeof deferred> }> = [];
  const containers = {
    imageExists: vi.fn(async (_ref: string) => false),
    build: vi.fn((folder: string, ref: string, _onLine: (l: string) => void, _labels?: string[]) => {
      const done = deferred();
      builds.push({ folder, ref, done });
      return done.promise;
    }),
  };
  const objects = vi.fn(async (_p: Project, _w: EnvWorktree, _paths: string[]) => list);
  const run = vi.fn(async (): Promise<RunResult> => ({ exitCode: 0, stdout: "0.89.0\n", stderr: "", timedOut: false }));
  return { images: new Images({ run, containers, objects }), containers, objects, builds, run };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("imageKey", () => {
  it("changes with each input", () => {
    const k = imageKey({ cliVersion: "0.89.0", objects: ["a", undefined], generation: 0 });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(imageKey({ cliVersion: "0.90.0", objects: ["a", undefined], generation: 0 })).not.toBe(k);
    expect(imageKey({ cliVersion: "0.89.0", objects: ["b", undefined], generation: 0 })).not.toBe(k);
    expect(imageKey({ cliVersion: "0.89.0", objects: [undefined, "a"], generation: 0 })).not.toBe(k);
    expect(imageKey({ cliVersion: "0.89.0", objects: ["a", undefined], generation: 1 })).not.toBe(k);
  });
  it("names the base image after the project and the key", () => {
    expect(baseImageRef("demo-abc123", "0123456789abcdef")).toBe("opendevhub/demo-abc123:0123456789ab-base");
  });
});

describe("Images.ensureBase", () => {
  it("labels the base image with its project", async () => {
    const { images, containers, builds } = setup();
    const p = images.ensureBase(project, wt("a"), [], () => {});
    await tick();
    builds[0].done.resolve();
    await p;
    expect(containers.build.mock.calls[0][3]).toEqual([`opendevhub.base-project=${project.id}`]);
  });

  it("reads the key inputs at the worktree's HEAD, with the key files", async () => {
    const { images, objects, builds } = setup();
    const p = images.ensureBase(project, wt("a"), ["package-lock.json"], () => {});
    await tick();
    builds[0].done.resolve();
    const { key, ref } = await p;
    expect(objects).toHaveBeenCalledWith(project, wt("a"), [".devcontainer", ".devcontainer.json", "package-lock.json"]);
    expect(ref).toBe(baseImageRef(project.id, key));
    expect(builds[0].folder).toBe("/src/demo.worktrees/a");
  });

  it("builds a missing image once for concurrent tasks that need it", async () => {
    const { images, containers, builds } = setup();
    const a = images.ensureBase(project, wt("a"), [], () => {});
    const b = images.ensureBase(project, wt("b"), [], () => {});
    await tick();
    expect(containers.build).toHaveBeenCalledTimes(1);
    builds[0].done.resolve();
    expect((await a).ref).toBe((await b).ref);
  });

  it("skips the build when the image exists", async () => {
    const { images, containers } = setup();
    containers.imageExists.mockResolvedValue(true);
    await images.ensureBase(project, wt("a"), [], () => {});
    expect(containers.build).not.toHaveBeenCalled();
  });

  it("builds one image at a time per project, and other projects in parallel", async () => {
    const { images, objects, builds } = setup();
    objects.mockImplementation(async (_p: Project, w: EnvWorktree) => [w.path]);
    const a = images.ensureBase(project, wt("a"), [], () => {});
    const b = images.ensureBase(project, wt("b"), [], () => {});
    const c = images.ensureBase(other, wt("c"), [], () => {});
    await tick();
    expect(builds.map((x) => x.folder)).toEqual(["/src/demo.worktrees/a", "/src/demo.worktrees/c"]);
    builds[0].done.resolve();
    await a;
    await tick();
    expect(builds.map((x) => x.folder)).toContain("/src/demo.worktrees/b");
    for (const x of builds) x.done.resolve();
    await Promise.all([b, c]);
  });

  it("lets the next request retry after a failed build", async () => {
    const { images, containers } = setup();
    containers.build.mockRejectedValueOnce(new Error("boom"));
    await expect(images.ensureBase(project, wt("a"), [], () => {})).rejects.toThrow("boom");
    containers.build.mockResolvedValueOnce(undefined);
    await expect(images.ensureBase(project, wt("a"), [], () => {})).resolves.toMatchObject({ key: expect.any(String) });
  });
});
