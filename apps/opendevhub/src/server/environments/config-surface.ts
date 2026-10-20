import { createHash } from "node:crypto";
import path from "node:path";

import type { ConfigRead } from "./containers";

/**
 * The part of a devcontainer configuration that acts on the host rather than in the container, normalized so the
 * same settings give the same value in every checkout of a project. An empty object needs no approval.
 */
export type HostSurface = Record<string, unknown>;

/** Stands for the checkout's folder, which differs between the main checkout and each worktree. */
export const WORKSPACE_PLACEHOLDER = "${localWorkspaceFolder}";

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === false ||
  value === "" ||
  (Array.isArray(value) && value.length === 0) ||
  (typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 0);

/** Replaces the checkout's own path in every string, so `${localWorkspaceFolder}` mounts match across checkouts. */
const placeheld = (value: unknown, root: string): unknown => {
  if (typeof value === "string") {
    return root ? value.replaceAll(root, WORKSPACE_PLACEHOLDER) : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => placeheld(v, root));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, placeheld(v, root)])
    );
  }
  return value;
};

const compareKeys = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/** JSON with object keys sorted and no whitespace: equal values give equal text. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => compareKeys(a, b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
};

export const fingerprint = (surface: HostSurface): string =>
  createHash("sha256").update(canonicalJson(surface)).digest("hex");

const configDirOf = (read: ConfigRead, root: string): string =>
  read.configFile
    ? path.dirname(read.configFile)
    : path.join(root, ".devcontainer");

/** A path from the config's folder, relative to the checkout; `outside` when it leaves it. */
const fromConfig = (
  read: ConfigRead,
  root: string,
  p: string
): { path: string; outside?: true } => {
  const abs = path.resolve(configDirOf(read, root), p);
  const rel = path.relative(root, abs) || ".";
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
    ? { outside: true, path: rel }
    : { path: rel };
};

const composeList = (read: ConfigRead): string[] => {
  const files = read.configuration.dockerComposeFile;
  const list = Array.isArray(files) ? files : [files];
  return list.filter((f): f is string => typeof f === "string" && f !== "");
};

/** The Docker Compose files a configuration names, as absolute paths on its node; their contents count too. */
export const composeFiles = (read: ConfigRead, root: string): string[] =>
  composeList(read).map((f) => path.resolve(configDirOf(read, root), f));

/** The merged mounts, each one a feature added marked with that feature's id. */
const markedMounts = (read: ConfigRead, mounts: unknown[]): unknown[] =>
  mounts.map((mount) => {
    const text = canonicalJson(mount);
    const from = read.features?.find((f) =>
      f.mounts?.some((m) => canonicalJson(m) === text)
    );
    return from ? { feature: from.feature, mount } : mount;
  });

const buildContext = (read: ConfigRead, root: string): unknown => {
  const cfg = read.configuration;
  const build = cfg.build as Record<string, unknown> | undefined;
  // `context` at the top level is the legacy form of `build.context`.
  const nested = build?.context;
  const legacy = cfg.context;
  let context: string | undefined;
  if (typeof nested === "string") {
    context = nested;
  } else if (typeof legacy === "string") {
    context = legacy;
  }
  return context === undefined ? undefined : fromConfig(read, root, context);
};

/**
 * The host-affecting settings of a checkout's configuration (see design decision 1). `root` is the checkout's folder
 * on its node; `files` holds the contents of `composeFiles(read, root)` by absolute path.
 */
export const hostSurface = (
  read: ConfigRead,
  root: string,
  files: Record<string, string> = {}
): HostSurface => {
  const cfg = read.configuration;
  // The merged form adds what features contribute; without it, the features themselves count.
  const merged = read.merged ?? cfg;
  const build = cfg.build as Record<string, unknown> | undefined;
  const compose = Object.fromEntries(
    composeList(read).map((f) => {
      const abs = path.resolve(configDirOf(read, root), f);
      return [fromConfig(read, root, f).path, files[abs] ?? null];
    })
  );
  const surface: HostSurface = {
    appPort: cfg.appPort,
    buildContext: buildContext(read, root),
    buildOptions: build?.options,
    capAdd: merged.capAdd,
    dockerComposeFile: compose,
    features: read.merged ? undefined : cfg.features,
    initializeCommand: cfg.initializeCommand,
    mounts: Array.isArray(merged.mounts)
      ? markedMounts(read, merged.mounts)
      : merged.mounts,
    privileged: merged.privileged,
    runArgs: cfg.runArgs,
    runServices: cfg.runServices,
    securityOpt: merged.securityOpt,
    // Only meaningful with Compose; for an image or Dockerfile config, opendevhub ignores it like the CLI does.
    service: Object.keys(compose).length > 0 ? cfg.service : undefined,
    workspaceMount: cfg.workspaceMount,
  };
  const checkout = root.replace(/\/+$/u, "");
  return Object.fromEntries(
    Object.entries(surface)
      .filter(([, v]) => !isEmpty(v))
      .map(([k, v]) => [k, placeheld(v, checkout)])
  );
};
