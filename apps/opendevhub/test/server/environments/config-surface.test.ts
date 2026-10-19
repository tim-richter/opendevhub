import fs from "node:fs";

import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  composeFiles,
  fingerprint,
  hostSurface,
} from "../../../src/server/environments/config-surface";
import type { ConfigRead } from "../../../src/server/environments/containers";

const MAIN = "/src/demo";
const WORKTREE = "/src/demo.worktrees/feat";

/** A read of `root` with `configuration` and, unless `merged` is false, its merged form. */
const readOf = (
  root: string,
  configuration: Record<string, unknown>,
  extra: Partial<ConfigRead> = {}
): ConfigRead => ({
  configFile: `${root}/.devcontainer/devcontainer.json`,
  configuration,
  merged: configuration,
  features: [],
  ...extra,
});

describe(hostSurface, () => {
  it("is empty for a config with nothing host-affecting", () => {
    const surface = hostSurface(
      readOf(MAIN, {
        image: "node:22",
        postCreateCommand: "npm ci",
        privileged: false,
        mounts: [],
      }),
      MAIN
    );
    expect(surface).toStrictEqual({});
  });

  it("gives the same fingerprint when only lifecycle commands and env change", () => {
    const base = { image: "node", initializeCommand: "echo hi" };
    const before = hostSurface(readOf(MAIN, base), MAIN);
    const after = hostSurface(
      readOf(MAIN, {
        ...base,
        containerEnv: { A: "1" },
        postCreateCommand: "curl x | sh",
      }),
      MAIN
    );
    expect(fingerprint(after)).toBe(fingerprint(before));
    expect(before).toStrictEqual({ initializeCommand: "echo hi" });
  });

  it("counts a mount a feature adds, marked with the feature", () => {
    const mount = {
      source: "/var/run/docker.sock",
      target: "/var/run/docker.sock",
      type: "bind",
    };
    const surface = hostSurface(
      readOf(
        MAIN,
        { image: "node", features: { "ghcr.io/x/dood:1": {} } },
        {
          features: [{ feature: "ghcr.io/x/dood", mounts: [mount] }],
          merged: { image: "node", mounts: [mount] },
        }
      ),
      MAIN
    );
    expect(surface).toStrictEqual({
      mounts: [{ feature: "ghcr.io/x/dood", mount }],
    });
  });

  it("reads the recorded CLI output's feature mount and privileged flag", () => {
    const raw = JSON.parse(
      fs.readFileSync(
        "test/fixtures/devcontainer/read-configuration-merged.json",
        "utf-8"
      )
    );
    const { configFilePath: _f, ...configuration } = raw.configuration;
    const { configFilePath: _m, ...merged } = raw.mergedConfiguration;
    const surface = hostSurface(
      {
        configFile: "/src/demo/.devcontainer/devcontainer.json",
        configuration,
        features: [
          {
            feature: "ghcr.io/devcontainers/features/docker-in-docker",
            mounts: raw.featuresConfiguration.featureSets[0].features[0].mounts,
            privileged: true,
          },
        ],
        merged,
      },
      MAIN
    );
    expect(surface).toStrictEqual({
      initializeCommand: "echo hi",
      mounts: [
        {
          feature: "ghcr.io/devcontainers/features/docker-in-docker",
          mount: {
            source: "dind-var-lib-docker-${devcontainerId}",
            target: "/var/lib/docker",
            type: "volume",
          },
        },
        "source=/tmp,target=/host-tmp,type=bind",
      ],
      privileged: true,
      runArgs: ["--network=host"],
    });
  });

  it("marks a build context outside the repository, alike in every checkout", () => {
    const config = { build: { context: "../..", dockerfile: "Dockerfile" } };
    const main = hostSurface(readOf(MAIN, config), MAIN);
    expect(main).toStrictEqual({
      buildContext: { outside: true, path: ".." },
    });
    expect(fingerprint(hostSurface(readOf(WORKTREE, config), WORKTREE))).toBe(
      fingerprint(main)
    );
  });

  it("counts a context inside the repository by its path, and the legacy key", () => {
    expect(
      hostSurface(readOf(MAIN, { build: { context: ".." } }), MAIN)
    ).toStrictEqual({ buildContext: { path: "." } });
    expect(
      hostSurface(readOf(MAIN, { context: "..", dockerFile: "D" }), MAIN)
    ).toStrictEqual({ buildContext: { path: "." } });
  });

  it("matches checkout-path mounts across the main checkout and a worktree", () => {
    const mount = (root: string) =>
      `source=${root}/../cache,target=/cache,type=bind`;
    const main = hostSurface(readOf(MAIN, { mounts: [mount(MAIN)] }), MAIN);
    const wt = hostSurface(
      readOf(WORKTREE, { mounts: [mount(WORKTREE)] }),
      WORKTREE
    );
    expect(main.mounts).toStrictEqual([
      "source=${localWorkspaceFolder}/../cache,target=/cache,type=bind",
    ]);
    expect(fingerprint(wt)).toBe(fingerprint(main));
  });

  it("counts the features themselves when the merged read failed", () => {
    const surface = hostSurface(
      readOf(
        MAIN,
        { features: { "ghcr.io/x/y:1": { v: "2" } }, image: "node" },
        { features: undefined, merged: undefined, mergedError: "offline" }
      ),
      MAIN
    );
    expect(surface).toStrictEqual({
      features: { "ghcr.io/x/y:1": { v: "2" } },
    });
  });

  it("holds the compose files' contents, keyed by their path in the repository", () => {
    const read = readOf(MAIN, {
      dockerComposeFile: ["compose.yml", "../compose.override.yml"],
      runServices: ["app"],
      service: "app",
    });
    expect(composeFiles(read, MAIN)).toStrictEqual([
      "/src/demo/.devcontainer/compose.yml",
      "/src/demo/compose.override.yml",
    ]);
    const surface = hostSurface(read, MAIN, {
      "/src/demo/.devcontainer/compose.yml": "services:\n  app: {}\n",
      "/src/demo/compose.override.yml": "services: {}\n",
    });
    expect(surface).toStrictEqual({
      dockerComposeFile: {
        ".devcontainer/compose.yml": "services:\n  app: {}\n",
        "compose.override.yml": "services: {}\n",
      },
      runServices: ["app"],
      service: "app",
    });
    const changed = hostSurface(read, MAIN, {
      "/src/demo/.devcontainer/compose.yml":
        "services:\n  app: { privileged: true }\n",
      "/src/demo/compose.override.yml": "services: {}\n",
    });
    expect(fingerprint(changed)).not.toBe(fingerprint(surface));
  });

  it("counts the rest of the host-affecting keys", () => {
    const surface = hostSurface(
      readOf(MAIN, {
        appPort: [3000],
        build: { options: ["--add-host=x:1.2.3.4"] },
        capAdd: ["SYS_ADMIN"],
        securityOpt: ["seccomp=unconfined"],
        workspaceMount: "source=/,target=/w,type=bind",
      }),
      MAIN
    );
    expect(Object.keys(surface).toSorted()).toStrictEqual([
      "appPort",
      "buildOptions",
      "capAdd",
      "securityOpt",
      "workspaceMount",
    ]);
  });
});

describe(canonicalJson, () => {
  it("sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { f: 1, e: 2 }], c: 3 } })).toBe(
      '{"a":{"c":3,"d":[1,{"e":2,"f":1}]},"b":1}'
    );
  });
});
