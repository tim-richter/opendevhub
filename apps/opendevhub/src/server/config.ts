import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ForgeKind, NodeId } from "../shared/types";
import type { ForgeEntry } from "./git/forge";
import { LOCAL_NODE } from "./nodes/host";

export interface Config {
  port: number;
  /** Absolute directories scanned for projects, set in Settings. */
  roots?: string[];
  /** Forge per git host: configured by hand or remembered after a probe. */
  forges?: Record<string, ForgeEntry>;
  /** Per-project settings keyed by the project's path (`{ name, isolation, keyFiles, sshAgent }`), validated where used. */
  projects?: Record<string, unknown>;
  /** Machines tasks can run on, besides this one. */
  nodes?: NodeConfig[];
}

export const DEFAULT_PORT = 7777;

export const configDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "opendevhub");
};

/** Where opendevhub keeps generated files: `$XDG_STATE_HOME/opendevhub`, default `~/.local/state/opendevhub`. */
export const stateDir = (env: NodeJS.ProcessEnv = process.env): string => {
  const xdg = env.XDG_STATE_HOME;
  const base =
    xdg && path.isAbsolute(xdg)
      ? xdg
      : path.join(os.homedir(), ".local", "state");
  return path.join(base, "opendevhub");
};

const readJson = <T extends object>(file: string, fallback: T): T => {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected a JSON object");
    }
    return value as T;
  } catch {
    fs.renameSync(file, `${file}.bak`);
    console.warn(
      `opendevhub: ${file} was corrupt; moved to ${file}.bak and starting fresh`
    );
    return fallback;
  }
};

export const writeJson = (file: string, value: unknown, mode: number): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
};

const FORGE_KINDS: ReadonlySet<ForgeKind> = new Set([
  "github",
  "gitlab",
  "forgejo",
  "gitea",
  "bitbucket",
  "unknown",
]);

const readForges = (raw: unknown): Record<string, ForgeEntry> => {
  const out: Record<string, ForgeEntry> = {};
  if (!raw || typeof raw !== "object") {
    return out;
  }
  for (const [host, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as { kind?: unknown; web?: unknown };
    if (
      !entry ||
      typeof entry !== "object" ||
      !FORGE_KINDS.has(entry.kind as ForgeKind)
    ) {
      continue;
    }
    out[host] = {
      kind: entry.kind as ForgeKind,
      ...(typeof entry.web === "string" ? { web: entry.web } : {}),
    };
  }
  return out;
};

/** A machine reached over ssh. */
export interface NodeConfig {
  id: NodeId;
  /** As the user's ssh config knows it: `host`, `user@host` or an alias. */
  ssh: string;
  label?: string;
}

export class InvalidNodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNodeError";
  }
}

const NODE_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
/** No whitespace, and no leading `-`: ssh would read that as an option (`-oProxyCommand=…`). */
const SSH_DEST = /^[^-\s]\S*$/u;

export const validateSshDestination = (dest: string): string => {
  const d = dest.trim();
  if (!SSH_DEST.test(d)) {
    throw new InvalidNodeError(
      `invalid ssh destination: ${JSON.stringify(dest)}`
    );
  }
  return d;
};

/** A node id from a label or destination: `tim@box.lan` → `box-lan`; taken ids and `local` get a suffix. */
export const nodeIdFor = (name: string, taken: string[]): NodeId => {
  const host = name.replace(/^.*@/u, "").replace(/:\d+$/u, "");
  const base =
    host
      .toLowerCase()
      .replaceAll(/[^a-z0-9-]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(0, 50)
      .replace(/-+$/u, "") || "node";
  let id = base;
  for (let n = 2; id === LOCAL_NODE || taken.includes(id); n += 1) {
    id = `${base}-${n}`;
  }
  return id;
};

const readNodes = (raw: unknown): NodeConfig[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: NodeConfig[] = [];
  for (const value of raw) {
    const n = value as { id?: unknown; ssh?: unknown; label?: unknown };
    if (
      !n ||
      typeof n !== "object" ||
      typeof n.id !== "string" ||
      typeof n.ssh !== "string"
    ) {
      continue;
    }
    if (
      !NODE_ID.test(n.id) ||
      n.id === LOCAL_NODE ||
      out.some((o) => o.id === n.id) ||
      !SSH_DEST.test(n.ssh)
    ) {
      continue;
    }
    out.push({
      id: n.id,
      ssh: n.ssh,
      ...(typeof n.label === "string" && n.label ? { label: n.label } : {}),
    });
  }
  return out;
};

export const addNode = (
  cfg: Config,
  input: { ssh: string; label?: string }
): { config: Config; node: NodeConfig } => {
  const ssh = validateSshDestination(input.ssh);
  const label = input.label?.trim() || undefined;
  const nodes = cfg.nodes ?? [];
  if (nodes.some((n) => n.ssh === ssh)) {
    throw new InvalidNodeError(`${ssh} is already a node`);
  }
  const node: NodeConfig = {
    id: nodeIdFor(
      label ?? ssh,
      nodes.map((n) => n.id)
    ),
    ssh,
    ...(label ? { label } : {}),
  };
  return { config: { ...cfg, nodes: [...nodes, node] }, node };
};

/** Why a node can't be removed yet: its environments would be stranded. */
export const nodeInUse = (id: NodeId, environments: number): string =>
  environments === 1
    ? `node ${id} still runs 1 task environment; remove it first`
    : `node ${id} still runs ${environments} task environments; remove them first`;

export const removeNode = (cfg: Config, id: NodeId): Config => ({
  ...cfg,
  nodes: (cfg.nodes ?? []).filter((n) => n.id !== id),
});

export const loadConfig = (dir: string): Config => {
  const raw = readJson<Partial<Config>>(path.join(dir, "config.json"), {});
  const forges = readForges(raw.forges);
  const nodes = readNodes(raw.nodes);
  const roots = Array.isArray(raw.roots)
    ? raw.roots.filter(
        (r): r is string => typeof r === "string" && path.isAbsolute(r)
      )
    : [];
  return {
    port: typeof raw.port === "number" ? raw.port : DEFAULT_PORT,
    ...(roots.length > 0 ? { roots } : {}),
    ...(Object.keys(forges).length > 0 ? { forges } : {}),
    ...(nodes.length > 0 ? { nodes } : {}),
    ...(raw.projects &&
    typeof raw.projects === "object" &&
    !Array.isArray(raw.projects)
      ? { projects: raw.projects }
      : {}),
  };
};

export const saveConfig = (dir: string, cfg: Config): void => {
  writeJson(path.join(dir, "config.json"), cfg, 0o644);
};

export interface ForgeStore {
  all: () => Record<string, ForgeEntry>;
  remember: (host: string, entry: ForgeEntry) => void;
}

/** Forges in `config.json`; remembering re-reads the file so settings changed meanwhile aren't lost. */
export class FileForgeStore implements ForgeStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  all(): Record<string, ForgeEntry> {
    return loadConfig(this.dir).forges ?? {};
  }

  remember(host: string, entry: ForgeEntry): void {
    const cfg = loadConfig(this.dir);
    saveConfig(this.dir, { ...cfg, forges: { ...cfg.forges, [host]: entry } });
  }
}

export interface ProjectSettingsStore {
  get: (projectPath: string) => Record<string, unknown>;
  /** Replaces the given keys of the project's entry; an undefined value removes the key. */
  update: (projectPath: string, patch: Record<string, unknown>) => void;
}

/** A project's entry in `config.json` `projects`; updating re-reads the file so settings changed meanwhile aren't lost. */
export class FileProjectSettings implements ProjectSettingsStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  get(projectPath: string): Record<string, unknown> {
    const entry = loadConfig(this.dir).projects?.[projectPath];
    return entry && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, unknown>)
      : {};
  }

  update(projectPath: string, patch: Record<string, unknown>): void {
    const cfg = loadConfig(this.dir);
    const entry = { ...this.get(projectPath), ...patch };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) {
        delete entry[k];
      }
    }
    saveConfig(this.dir, {
      ...cfg,
      projects: { ...cfg.projects, [projectPath]: entry },
    });
  }
}

const expandHome = (p: string): string => {
  if (p === "~") {
    return os.homedir();
  }
  if (p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
};

export class InvalidRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRootError";
  }
}

/** Scan roots as Settings submits them: absolute or `~` paths to existing directories, deduplicated. */
export const validateRoots = (input: unknown): string[] => {
  if (!Array.isArray(input)) {
    throw new InvalidRootError("roots must be a list of folders");
  }
  const out: string[] = [];
  for (const value of input) {
    const raw = typeof value === "string" ? value.trim() : "";
    const expanded = expandHome(raw);
    if (!path.isAbsolute(expanded)) {
      throw new InvalidRootError(
        `${JSON.stringify(raw)} is not an absolute path`
      );
    }
    const abs = path.resolve(expanded);
    if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
      throw new InvalidRootError(`${abs} is not a folder`);
    }
    if (!out.includes(abs)) {
      out.push(abs);
    }
  }
  return out;
};
