import { createHash } from "node:crypto";

import { slugify } from "../shared/tasks";
import type { EnvId, Isolation, ProjectId } from "../shared/types";

const MAX_LABEL = 63;
const BRANCH_SLUG_MAX = 20;

/** `<projectId>-<branch slug>-<hash4>`, at most 63 characters so it works as a hostname label. */
export const envIdFor = (
  projectId: ProjectId,
  worktreePath: string,
  branch: string
): EnvId => {
  const hash = createHash("sha256")
    .update(`${projectId}\0${worktreePath}`)
    .digest("hex")
    .slice(0, 4);
  const tail = `-${slugify(branch, BRANCH_SLUG_MAX) || "worktree"}-${hash}`;
  return projectId.slice(0, MAX_LABEL - tail.length).replace(/-+$/u, "") + tail;
};

export interface EnvSettings {
  isolation: Isolation;
  /** Files whose change invalidates the image, relative to the repository root. */
  keyFiles: string[];
  /** Forward the host's ssh-agent into the project's containers. */
  sshAgent: boolean;
}

const KEY_FILE = /^[\w.@+][\w.@+/-]*$/u;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** `customizations.opendevhub` from devcontainer.json, with the project's `config.json` entry taking precedence. */
export const resolveEnvSettings = (
  custom: unknown,
  override: unknown
): EnvSettings => {
  const c = record(custom);
  const o = record(override);
  const isolation =
    [o.isolation, c.isolation].find(
      (v): v is Isolation => v === "shared" || v === "isolated"
    ) ?? "shared";
  let files;
  if (Array.isArray(o.keyFiles)) {
    files = o.keyFiles;
  } else if (Array.isArray(c.keyFiles)) {
    files = c.keyFiles;
  } else {
    files = [];
  }
  const sshAgent =
    [o.sshAgent, c.sshAgent].find(
      (v): v is boolean => typeof v === "boolean"
    ) ?? true;
  return {
    isolation,
    keyFiles: files.filter(
      (f): f is string =>
        typeof f === "string" &&
        KEY_FILE.test(f) &&
        !f.split("/").includes("..")
    ),
    sshAgent,
  };
};

export const LIFECYCLE_KEYS = [
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
  "postAttachCommand",
] as const;

/** Keys that describe how to build the image; the pinned image already carries their result in its label. */
const IMAGE_KEYS = new Set([
  "image",
  "build",
  "dockerFile",
  "context",
  "dockerComposeFile",
  "service",
  "runServices",
  "features",
  "overrideFeatureInstallOrder",
]);

const PUBLISH = /^(?<g1>-p|-P$|--publish(?<g2>-all)?(?<g3>=|$))/u;

const escapeRegExp = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Matches `folder` as a whole path or a path prefix, not as the start of a longer name. */
const folderPattern = (folder: string): RegExp =>
  new RegExp(`${escapeRegExp(folder)}(?=$|[^\\w.-])`, "gu");

/** Why this config can't run one container per worktree; undefined when it can. */
export const isolationBlocker = (
  config: Record<string, unknown>,
  guessedFolder?: string
): string | undefined => {
  if (config.dockerComposeFile !== undefined) {
    return "Docker Compose configurations can't run in their own container yet";
  }
  if (config.appPort !== undefined) {
    return "appPort publishes host ports, which several containers can't share";
  }
  const args = Array.isArray(config.runArgs)
    ? config.runArgs.filter((a): a is string => typeof a === "string")
    : [];
  if (args.some((a) => PUBLISH.test(a))) {
    return "runArgs publish host ports (-p/--publish), which several containers can't share";
  }
  if (
    args.some(
      (a, i) =>
        /^--net(?<g1>work)?=host$/u.test(a) ||
        (/^--net(?<g1>work)?$/u.test(a) && args[i + 1] === "host")
    )
  ) {
    return "host networking is not supported";
  }
  if (
    guessedFolder &&
    LIFECYCLE_KEYS.some(
      (k) =>
        config[k] !== undefined &&
        folderPattern(guessedFolder).test(JSON.stringify(config[k]))
    )
  ) {
    return "a lifecycle command uses ${containerWorkspaceFolder}, which can't point at each task's worktree yet";
  }
  return undefined;
};

const replaceFolder = (value: unknown, from: string, to: string): unknown => {
  if (typeof value === "string") {
    return value.replace(folderPattern(from), to);
  }
  if (Array.isArray(value)) {
    return value.map((v) => replaceFolder(v, from, to));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, replaceFolder(v, from, to)])
    );
  }
  return value;
};

const withoutName = (args: unknown[]): unknown[] => {
  const out: unknown[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--name") {
      i += 1;
    } else if (
      typeof args[i] === "string" &&
      (args[i] as string).startsWith("--name=")
    ) {
      continue;
    } else {
      out.push(args[i]);
    }
  }
  return out;
};

export interface OverrideInput {
  /** The worktree's configuration, as `devcontainer read-configuration` printed it. */
  config: Record<string, unknown>;
  /** Where read-configuration assumed the workspace would be mounted (`/workspaces/<dir>`). */
  guessedFolder?: string;
  image: string;
  worktree: { hostPath: string; path: string };
  /** The project's .git folder on this machine and in the main container. */
  gitDir: { host: string; container: string };
}

/**
 * The devcontainer.json a task container starts from: the worktree's config with the image pinned, the
 * worktree mounted where the main container sees it, and the repository's .git next to it, so git links
 * resolve the same way in both containers.
 */
export const buildOverrideConfig = (
  input: OverrideInput
): {
  config: Record<string, unknown>;
  notes: string[];
} => {
  const notes: string[] = [];
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.config)) {
    if (
      key === "configFilePath" ||
      IMAGE_KEYS.has(key) ||
      (LIFECYCLE_KEYS as readonly string[]).includes(key)
    ) {
      continue;
    }
    config[key] = input.guessedFolder
      ? replaceFolder(value, input.guessedFolder, input.worktree.path)
      : value;
  }
  config.image = input.image;
  config.workspaceMount = `type=bind,source=${input.worktree.hostPath},target=${input.worktree.path}`;
  config.workspaceFolder = input.worktree.path;
  config.mounts = [
    ...(Array.isArray(config.mounts) ? config.mounts : []),
    `type=bind,source=${input.gitDir.host},target=${input.gitDir.container}`,
  ];
  if (Array.isArray(config.runArgs)) {
    const kept = withoutName(config.runArgs);
    if (kept.length !== config.runArgs.length) {
      notes.push(
        "removed --name from runArgs: every task container needs its own name"
      );
    }
    config.runArgs = kept;
  }
  return { config, notes };
};
