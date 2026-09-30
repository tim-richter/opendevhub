import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProjectId } from "../shared/types";

export interface Config {
  roots: string[];
  port: number;
}

export interface PersistedRuntime {
  containerId?: string;
  password?: string;
  workspaceFolder?: string;
}

export interface PersistedState {
  projects: Record<ProjectId, PersistedRuntime>;
}

export const DEFAULT_PORT = 7777;

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
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

function writeJson(file: string, value: unknown, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode });
  fs.renameSync(tmp, file);
}

export function loadConfig(dir: string): Config {
  const raw = readJson<Partial<Config>>(path.join(dir, "config.json"), {});
  return {
    roots: Array.isArray(raw.roots) ? raw.roots.filter((r) => typeof r === "string") : [],
    port: typeof raw.port === "number" ? raw.port : DEFAULT_PORT,
  };
}

export function saveConfig(dir: string, cfg: Config): void {
  writeJson(path.join(dir, "config.json"), cfg, 0o644);
}

export function loadState(dir: string): PersistedState {
  const raw = readJson<Partial<PersistedState>>(path.join(dir, "state.json"), {});
  return { projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {} };
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
