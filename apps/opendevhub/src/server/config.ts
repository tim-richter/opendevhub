import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EnvId, EnvWorktree, ForgeKind, ProjectId } from "../shared/types";
import type { ForgeEntry } from "./forge";

export interface Config {
  roots: string[];
  port: number;
  /** Forge per git host: configured by hand or remembered after a probe. */
  forges?: Record<string, ForgeEntry>;
  /** Per-project settings keyed by the project's path (`{ isolation, keyFiles, sshAgent }`), validated where used. */
  projects?: Record<string, unknown>;
}

export interface PersistedRuntime {
  containerId?: string;
  password?: string;
  workspaceFolder?: string;
  relayToken?: string;
  remoteUser?: string;
}

/** A task environment as state.json keeps it. */
export interface PersistedEnv extends PersistedRuntime {
  projectId: ProjectId;
  worktree: EnvWorktree;
  image?: { key: string; ref: string };
}

export interface PersistedState {
  projects: Record<ProjectId, PersistedRuntime>;
  environments?: Record<EnvId, PersistedEnv>;
}

export const DEFAULT_PORT = 7777;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
  return path.join(base, "opendevhub");
}

/** Where opendevhub keeps generated files: `$XDG_STATE_HOME/opendevhub`, default `~/.local/state/opendevhub`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(base, "opendevhub");
}

function readJson<T>(file: string, fallback: T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    fs.renameSync(file, `${file}.bak`);
    console.warn(`opendevhub: ${file} was corrupt; moved to ${file}.bak and starting fresh`);
    return fallback;
  }
}

export function writeJson(file: string, value: unknown, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(tmp, file);
}

const FORGE_KINDS: readonly ForgeKind[] = ["github", "gitlab", "forgejo", "gitea", "bitbucket", "unknown"];

function readForges(raw: unknown): Record<string, ForgeEntry> {
  const out: Record<string, ForgeEntry> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [host, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as { kind?: unknown; web?: unknown };
    if (!entry || typeof entry !== "object" || !FORGE_KINDS.includes(entry.kind as ForgeKind)) continue;
    out[host] = { kind: entry.kind as ForgeKind, ...(typeof entry.web === "string" ? { web: entry.web } : {}) };
  }
  return out;
}

export function loadConfig(dir: string): Config {
  const raw = readJson<Partial<Config>>(path.join(dir, "config.json"), {});
  const forges = readForges(raw.forges);
  return {
    roots: Array.isArray(raw.roots) ? raw.roots.filter((r) => typeof r === "string") : [],
    port: typeof raw.port === "number" ? raw.port : DEFAULT_PORT,
    ...(Object.keys(forges).length > 0 ? { forges } : {}),
    ...(raw.projects && typeof raw.projects === "object" && !Array.isArray(raw.projects) ? { projects: raw.projects } : {}),
  };
}

export function saveConfig(dir: string, cfg: Config): void {
  writeJson(path.join(dir, "config.json"), cfg, 0o644);
}

export interface ForgeStore {
  all(): Record<string, ForgeEntry>;
  remember(host: string, entry: ForgeEntry): void;
}

/** Forges in `config.json`; remembering re-reads the file so settings changed meanwhile aren't lost. */
export class FileForgeStore implements ForgeStore {
  constructor(private readonly dir: string) {}

  all(): Record<string, ForgeEntry> {
    return loadConfig(this.dir).forges ?? {};
  }

  remember(host: string, entry: ForgeEntry): void {
    const cfg = loadConfig(this.dir);
    saveConfig(this.dir, { ...cfg, forges: { ...cfg.forges, [host]: entry } });
  }
}

export interface ProjectSettingsStore {
  get(projectPath: string): Record<string, unknown>;
  /** Replaces the given keys of the project's entry; an undefined value removes the key. */
  update(projectPath: string, patch: Record<string, unknown>): void;
}

/** A project's entry in `config.json` `projects`; updating re-reads the file so settings changed meanwhile aren't lost. */
export class FileProjectSettings implements ProjectSettingsStore {
  constructor(private readonly dir: string) {}

  get(projectPath: string): Record<string, unknown> {
    const entry = loadConfig(this.dir).projects?.[projectPath];
    return entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
  }

  update(projectPath: string, patch: Record<string, unknown>): void {
    const cfg = loadConfig(this.dir);
    const entry = { ...this.get(projectPath), ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete entry[k];
    saveConfig(this.dir, { ...cfg, projects: { ...cfg.projects, [projectPath]: entry } });
  }
}

export function loadState(dir: string): PersistedState {
  const raw = readJson<Partial<PersistedState>>(path.join(dir, "state.json"), {});
  const environments = raw.environments && typeof raw.environments === "object" ? raw.environments : undefined;
  return { projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {}, ...(environments ? { environments } : {}) };
}

export function saveState(dir: string, state: PersistedState): void {
  writeJson(path.join(dir, "state.json"), state, 0o600);
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function mergeRoots(existing: string[], added: string[], cwd = process.cwd()): string[] {
  const out: string[] = [];
  for (const r of [...existing, ...added]) {
    const abs = path.resolve(cwd, expandHome(r));
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}
