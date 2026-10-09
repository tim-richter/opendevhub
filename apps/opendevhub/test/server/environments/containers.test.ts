import { describe, expect, it } from "vitest";

import {
  CommandError,
  Containers,
  ENV_LABEL,
  ENV_PROJECT_LABEL,
  envLabels,
  LABEL,
  parseImageInspect,
  parseInspect,
  parseUpOutput,
} from "../../../src/server/environments/containers";
import type { Project } from "../../../src/shared/types";
import { fakeRunner } from "../../helpers/fake-runner";

const project: Project = {
  id: "demo-1a2b3c",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
};
const okUp =
  "[2026-09-30T10:00:00Z] Start: Run: docker build\n" +
  '{"outcome":"success","containerId":"abc123","remoteUser":"node","remoteWorkspaceFolder":"/workspaces/demo"}\n';
const inspectJson = JSON.stringify({
  Id: "abc123",
  Name: "/eager_demo",
  State: { Running: true },
  Mounts: [
    { Type: "bind", Source: "/src/demo", Destination: "/workspaces/demo" },
    {
      Type: "bind",
      Source: "/src/demo.worktrees",
      Destination: "/workspaces/demo.worktrees",
    },
    {
      Type: "volume",
      Source: "/var/lib/docker/volumes/x",
      Destination: "/vscode",
    },
  ],
  Config: { Labels: { [LABEL]: "demo-1a2b3c" } },
  NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.5" } } },
});

describe(parseUpOutput, () => {
  const base = { exitCode: 0, stderr: "", timedOut: false };

  it("parses the success line", () => {
    expect(parseUpOutput({ ...base, stdout: okUp }, "/fallback")).toStrictEqual(
      {
        containerId: "abc123",
        remoteWorkspaceFolder: "/workspaces/demo",
        remoteUser: "node",
      }
    );
  });

  it("throws the devcontainer error message with stderr tail", () => {
    const stdout =
      '{"outcome":"error","message":"Command failed: docker build","description":"An error occurred"}';
    try {
      parseUpOutput(
        { ...base, exitCode: 1, stdout, stderr: "step 1\nboom" },
        "/f"
      );
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as Error).message).toMatch(/Command failed: docker build/u);
      expect((error as CommandError).tail).toStrictEqual(["step 1", "boom"]);
    }
  });

  it("reports timeouts", () => {
    expect(() =>
      parseUpOutput({ ...base, exitCode: 1, stdout: "", timedOut: true }, "/f")
    ).toThrow(/timed out/u);
  });

  it("reports missing result JSON with exit code", () => {
    expect(() =>
      parseUpOutput(
        { ...base, exitCode: 1, stdout: "noise only", stderr: "x" },
        "/f"
      )
    ).toThrow(/exited with code 1/u);
  });

  it("falls back when remoteWorkspaceFolder is absent", () => {
    const stdout = '{"outcome":"success","containerId":"c"}';
    expect(
      parseUpOutput({ ...base, stdout }, "/workspaces/demo")
        .remoteWorkspaceFolder
    ).toBe("/workspaces/demo");
  });
});

describe(Containers, () => {
  it("up passes workspace folder and id label, streams lines", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: okUp }));
    const lines: string[] = [];
    const res = await new Containers(run).up(project, {
      rebuild: false,
      onLine: (l) => lines.push(l),
    });
    expect(res.containerId).toBe("abc123");
    expect(calls[0].cmd).toBe("devcontainer");
    expect(calls[0].args).toStrictEqual([
      "up",
      "--workspace-folder",
      "/src/demo",
      "--id-label",
      `${LABEL}=demo-1a2b3c`,
    ]);
    calls[0].opts?.onLine?.("hello");
    expect(lines).toStrictEqual(["hello"]);
  });

  it("up with rebuild removes the existing container", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: okUp }));
    await new Containers(run).up(project, { rebuild: true, onLine: () => {} });
    expect(calls[0].args).toContain("--remove-existing-container");
  });

  it("up without cache builds the image without the layer cache", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: okUp }));
    await new Containers(run).up(project, {
      noCache: true,
      onLine: () => {},
      rebuild: true,
    });
    expect(calls[0].args).toContain("--build-no-cache");
  });

  it("inspect parses state, ip and label; undefined on failure", async () => {
    const ok = fakeRunner(() => ({ stdout: `${inspectJson}\n` }));
    await expect(
      new Containers(ok.run).inspect("abc123")
    ).resolves.toStrictEqual({
      id: "abc123",
      name: "eager_demo",
      running: true,
      ip: "172.17.0.5",
      network: "bridge",
      projectId: "demo-1a2b3c",
      binds: {
        "/workspaces/demo": "/src/demo",
        "/workspaces/demo.worktrees": "/src/demo.worktrees",
      },
    });
    const missing = fakeRunner(() => ({
      exitCode: 1,
      stderr: "No such container",
    }));
    await expect(
      new Containers(missing.run).inspect("nope")
    ).resolves.toBeUndefined();
  });

  it("listManaged filters by label and inspects each id", async () => {
    const { run, calls } = fakeRunner((c) =>
      c.args[0] === "ps" ? { stdout: "abc123\n" } : { stdout: inspectJson }
    );
    const list = await new Containers(run).listManaged();
    expect(calls[0].args).toStrictEqual([
      "ps",
      "-a",
      "--filter",
      `label=${LABEL}`,
      "--format",
      "{{.ID}}",
    ]);
    expect(list.map((c) => c.id)).toStrictEqual(["abc123"]);
  });

  it("stop throws CommandError on failure", async () => {
    const { run } = fakeRunner(() => ({ exitCode: 1, stderr: "daemon down" }));
    await expect(new Containers(run).stop("abc")).rejects.toBeInstanceOf(
      CommandError
    );
  });

  it("exec forwards env as --remote-env before the command", async () => {
    const { run, calls } = fakeRunner();
    await new Containers(run).exec(project, ["opencode", "--version"], {
      env: { A: "1" },
    });
    expect(calls[0].args).toStrictEqual([
      "exec",
      "--workspace-folder",
      "/src/demo",
      "--id-label",
      `${LABEL}=demo-1a2b3c`,
      "--remote-env",
      "A=1",
      "opencode",
      "--version",
    ]);
    expect(calls[0].opts?.timeoutMs).toBe(30_000);
  });
});

describe("Containers mounts and workspace folder", () => {
  it("up adds each extra mount", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: okUp }));
    await new Containers(run).up(project, {
      rebuild: true,
      onLine: () => {},
      mounts: ["type=bind,source=/a,target=/b"],
    });
    expect(calls[0].args.slice(-3)).toStrictEqual([
      "--remove-existing-container",
      "--mount",
      "type=bind,source=/a,target=/b",
    ]);
  });

  it("reads the planned workspace folder from read-configuration", async () => {
    const stdout = JSON.stringify({
      configuration: {},
      workspace: { workspaceFolder: "/workspaces/demo" },
    });
    const { run, calls } = fakeRunner(() => ({ stdout }));
    await expect(new Containers(run).workspaceFolder(project)).resolves.toBe(
      "/workspaces/demo"
    );
    expect(calls[0].args).not.toContain("--include-merged-configuration");
    await expect(
      new Containers(fakeRunner(() => ({ exitCode: 1 })).run).workspaceFolder(
        project
      )
    ).resolves.toBeUndefined();
    await expect(
      new Containers(
        fakeRunner(() => ({ stdout: "not json" })).run
      ).workspaceFolder(project)
    ).resolves.toBeUndefined();
  });
});

describe("Containers.readConfiguration", () => {
  it("runs read-configuration with the id label and merged config, preferring mergedConfiguration", async () => {
    const stdout = JSON.stringify({
      configuration: { forwardPorts: [1] },
      mergedConfiguration: {
        forwardPorts: [3000, "db:5432"],
        portsAttributes: { "3000": { label: "web" } },
      },
    });
    const { run, calls } = fakeRunner(() => ({ stdout }));
    const cfg = await new Containers(run).readConfiguration(project);
    expect(calls[0].args).toStrictEqual([
      "read-configuration",
      "--workspace-folder",
      "/src/demo",
      "--id-label",
      `${LABEL}=demo-1a2b3c`,
      "--include-merged-configuration",
    ]);
    expect(calls[0].opts?.timeoutMs).toBe(60_000);
    expect(cfg).toStrictEqual({
      forwardPorts: [3000, "db:5432"],
      portsAttributes: { "3000": { label: "web" } },
      configuration: { forwardPorts: [1] },
    });
  });

  it("falls back to configuration and defaults missing fields", async () => {
    const { run } = fakeRunner(() => ({
      stdout: JSON.stringify({ configuration: { forwardPorts: [8080] } }),
    }));
    await expect(
      new Containers(run).readConfiguration(project)
    ).resolves.toStrictEqual({
      forwardPorts: [8080],
      portsAttributes: {},
      configuration: { forwardPorts: [8080] },
    });
    const empty = fakeRunner(() => ({ stdout: "{}" }));
    await expect(
      new Containers(empty.run).readConfiguration(project)
    ).resolves.toStrictEqual({ forwardPorts: [], portsAttributes: {} });
  });

  it("throws CommandError on failure or invalid output", async () => {
    const failed = fakeRunner(() => ({
      exitCode: 1,
      stderr: "Dev container config not found",
    }));
    await expect(
      new Containers(failed.run).readConfiguration(project)
    ).rejects.toBeInstanceOf(CommandError);
    const garbage = fakeRunner(() => ({ stdout: "not json" }));
    await expect(
      new Containers(garbage.run).readConfiguration(project)
    ).rejects.toThrow(/invalid JSON/u);
  });
});

describe("exec targets", () => {
  it("keeps addressing a project's container by its project label", async () => {
    const { run, calls } = fakeRunner();
    await new Containers(run).exec(project, ["pwd"]);
    expect(calls[0].args).toStrictEqual([
      "exec",
      "--workspace-folder",
      "/src/demo",
      "--id-label",
      `${LABEL}=demo-1a2b3c`,
      "pwd",
    ]);
  });

  it("addresses a task environment by its own labels and generated config", async () => {
    const { run, calls } = fakeRunner();
    const target = {
      id: "demo-1a2b3c-feat-0a1b",
      path: "/src/demo.worktrees/feat",
      idLabels: [
        "opendevhub.env=demo-1a2b3c-feat-0a1b",
        "opendevhub.env-project=demo-1a2b3c",
      ],
      overrideConfig: "/state/envs/demo-1a2b3c-feat-0a1b/devcontainer.json",
    };
    await new Containers(run).exec(target, ["pwd"]);
    expect(calls[0].args).toStrictEqual([
      "exec",
      "--workspace-folder",
      "/src/demo.worktrees/feat",
      "--id-label",
      "opendevhub.env=demo-1a2b3c-feat-0a1b",
      "--id-label",
      "opendevhub.env-project=demo-1a2b3c",
      "--override-config",
      "/state/envs/demo-1a2b3c-feat-0a1b/devcontainer.json",
      "pwd",
    ]);
  });
});

describe("task environment containers", () => {
  const taskInspect = JSON.stringify({
    Id: "def456",
    Name: "/task",
    State: { Running: true },
    Config: {
      Image: "vsc-feat-1234-uid",
      Labels: {
        [ENV_LABEL]: "demo-1a2b3c-feat-0a1b",
        [ENV_PROJECT_LABEL]: "demo-1a2b3c",
      },
    },
    NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.6" } } },
  });

  it("reads a task container's labels without making it look like a project's", () => {
    const info = parseInspect(taskInspect);
    expect(info).toMatchObject({
      id: "def456",
      envId: "demo-1a2b3c-feat-0a1b",
      envProjectId: "demo-1a2b3c",
      image: "vsc-feat-1234-uid",
    });
    expect(info.projectId).toBeUndefined();
  });

  it("labels task containers with their environment and project", () => {
    expect(envLabels("e", "p")).toStrictEqual([
      `${ENV_LABEL}=e`,
      `${ENV_PROJECT_LABEL}=p`,
    ]);
  });

  it("lists project and task containers", async () => {
    const { run, calls } = fakeRunner(({ args }) => {
      if (args[0] === "ps") {
        return {
          stdout: args.includes(`label=${LABEL}`) ? "abc123\n" : "def456\n",
        };
      }
      return { stdout: args.at(-1) === "abc123" ? inspectJson : taskInspect };
    });
    const list = await new Containers(run).listManaged();
    expect(list.map((c) => c.id)).toStrictEqual(["abc123", "def456"]);
    expect(
      calls.filter((c) => c.args[0] === "ps").map((c) => c.args)
    ).toStrictEqual([
      ["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.ID}}"],
      ["ps", "-a", "--filter", `label=${ENV_LABEL}`, "--format", "{{.ID}}"],
    ]);
  });

  it("reads a folder's configuration and the workspace folder the CLI would use", async () => {
    const stdout = JSON.stringify({
      configuration: { image: "node", configFilePath: { fsPath: "/x" } },
      workspace: { workspaceFolder: "/workspaces/feat" },
    });
    const { run, calls } = fakeRunner(() => ({ stdout }));
    await expect(
      new Containers(run).readConfig("/src/demo.worktrees/feat")
    ).resolves.toStrictEqual({
      configuration: { image: "node" },
      workspaceFolder: "/workspaces/feat",
    });
    expect(calls[0].args).toStrictEqual([
      "read-configuration",
      "--workspace-folder",
      "/src/demo.worktrees/feat",
    ]);
  });

  it("passes labels to the build", async () => {
    const ok = fakeRunner(() => ({
      stdout: '{"outcome":"success","imageName":["img"]}',
    }));
    await new Containers(ok.run).build("/f", "img", () => {}, ["a=1", "b=2"]);
    expect(ok.calls[0].args).toStrictEqual([
      "build",
      "--workspace-folder",
      "/f",
      "--image-name",
      "img",
      "--label",
      "a=1",
      "--label",
      "b=2",
    ]);
  });

  it("builds an image and reports the CLI's error", async () => {
    const ok = fakeRunner(() => ({
      stdout: '{"outcome":"success","imageName":["img"]}\n',
    }));
    await new Containers(ok.run).build("/f", "img", () => {});
    expect(ok.calls[0].args).toStrictEqual([
      "build",
      "--workspace-folder",
      "/f",
      "--image-name",
      "img",
    ]);
    const bad = fakeRunner(() => ({
      exitCode: 1,
      stdout: '{"outcome":"error","message":"no Dockerfile"}\n',
      stderr: "boom",
    }));
    await expect(
      new Containers(bad.run).build("/f", "img", () => {})
    ).rejects.toThrow(/devcontainer build failed: no Dockerfile/u);
  });

  it("checks for an image, removes containers (a missing one is fine) and removes images", async () => {
    const { run, calls } = fakeRunner(({ args }) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return { exitCode: args.at(-1) === "there" ? 0 : 1 };
      }
      if (args[0] === "rm" && args.at(-1) === "gone") {
        return { exitCode: 1, stderr: "Error: No such container: gone" };
      }
      return {};
    });
    const c = new Containers(run);
    await expect(c.imageExists("there")).resolves.toBeTruthy();
    await expect(c.imageExists("missing")).resolves.toBeFalsy();
    await c.remove("gone");
    await c.remove("c2");
    expect(calls.at(-1)?.args).toStrictEqual(["rm", "-f", "c2"]);
    await expect(c.removeImage("img")).resolves.toBeTruthy();
    expect(calls.at(-1)?.args).toStrictEqual(["image", "rm", "img"]);
  });

  it("returns the raw configuration with the port settings", async () => {
    const stdout = JSON.stringify({
      configuration: {
        customizations: { opendevhub: { isolation: "isolated" } },
      },
      mergedConfiguration: { forwardPorts: [3000] },
    });
    const { run } = fakeRunner(() => ({ stdout }));
    const cfg = await new Containers(run).readConfiguration(project);
    expect(cfg.forwardPorts).toStrictEqual([3000]);
    expect(cfg.configuration).toStrictEqual({
      customizations: { opendevhub: { isolation: "isolated" } },
    });
  });
});
describe("parseInspect imageId", () => {
  it("reads the image id a container runs", () => {
    const info = parseInspect(
      JSON.stringify({
        Id: "c1",
        Image: "sha256:abc",
        Config: { Image: "vsc-x-uid", Labels: {} },
      })
    );
    expect(info.imageId).toBe("sha256:abc");
    expect(info.image).toBe("vsc-x-uid");
  });
});

describe(parseImageInspect, () => {
  it("reads id, tags, size, creation time and labels", () => {
    const json = JSON.stringify([
      {
        Id: "sha256:a",
        RepoTags: ["opendevhub/demo:111111111111-base"],
        Size: 1234,
        Created: "2026-10-05T10:00:00Z",
        Config: { Labels: { "opendevhub.base-project": "demo" } },
      },
      {
        Id: "sha256:b",
        RepoTags: null,
        Size: 5,
        Created: "2026-10-05T11:00:00.123456789Z",
        Config: { Labels: null },
      },
    ]);
    expect(parseImageInspect(json)).toStrictEqual([
      {
        id: "sha256:a",
        refs: ["opendevhub/demo:111111111111-base"],
        bytes: 1234,
        created: Date.parse("2026-10-05T10:00:00Z"),
        labels: { "opendevhub.base-project": "demo" },
      },
      {
        id: "sha256:b",
        refs: [],
        bytes: 5,
        created: Date.parse("2026-10-05T11:00:00.123Z"),
        labels: {},
      },
    ]);
  });
});

describe("Containers.listImages", () => {
  it("inspects the union of each filter's images once", async () => {
    const { run, calls } = fakeRunner(({ args }) => {
      if (args[1] === "ls") {
        return {
          stdout: args.includes("reference=opendevhub/*")
            ? "sha256:a\nsha256:b\n"
            : "sha256:b\n",
        };
      }
      return {
        stdout: JSON.stringify([
          {
            Id: "sha256:a",
            RepoTags: [],
            Size: 1,
            Created: "2026-10-05T10:00:00Z",
            Config: {},
          },
        ]),
      };
    });
    const list = await new Containers(run).listImages([
      "reference=opendevhub/*",
      "label=x",
    ]);
    expect(list.map((i) => i.id)).toStrictEqual(["sha256:a"]);
    expect(calls[0].args).toStrictEqual([
      "image",
      "ls",
      "-q",
      "--no-trunc",
      "--filter",
      "reference=opendevhub/*",
    ]);
    expect(calls[2].args).toStrictEqual([
      "image",
      "inspect",
      "sha256:a",
      "sha256:b",
    ]);
  });

  it("skips inspect when nothing matches", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: "" }));
    await expect(
      new Containers(run).listImages(["label=x"])
    ).resolves.toStrictEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("keeps what inspect printed when an image vanished in between", async () => {
    const { run } = fakeRunner(({ args }) =>
      args[1] === "ls"
        ? { stdout: "sha256:a\nsha256:gone\n" }
        : {
            exitCode: 1,
            stderr: "Error: No such image: sha256:gone",
            stdout: JSON.stringify([
              {
                Id: "sha256:a",
                RepoTags: [],
                Size: 1,
                Created: "2026-10-05T10:00:00Z",
              },
            ]),
          }
    );
    expect(
      (await new Containers(run).listImages(["label=x"])).map((i) => i.id)
    ).toStrictEqual(["sha256:a"]);
  });

  it("throws when docker can't list images", async () => {
    const { run } = fakeRunner(() => ({
      exitCode: 1,
      stderr: "Cannot connect to the Docker daemon",
    }));
    await expect(new Containers(run).listImages(["label=x"])).rejects.toThrow(
      /docker image ls failed: Cannot connect/u
    );
  });
});

describe("Containers.inspect over ssh", () => {
  it("throws when ssh fails, instead of reporting the container gone", async () => {
    const down = new Containers(
      fakeRunner(() => ({
        exitCode: 255,
        stderr: "ssh: connect to host box port 22: Connection refused\n",
      })).run
    );
    await expect(down.inspect("c1")).rejects.toThrow(
      /docker inspect could not run.*Connection refused/u
    );
    const gone = new Containers(
      fakeRunner(() => ({
        exitCode: 1,
        stderr: "Error: No such container: c1\n",
      })).run
    );
    await expect(gone.inspect("c1")).resolves.toBeUndefined();
  });
});
