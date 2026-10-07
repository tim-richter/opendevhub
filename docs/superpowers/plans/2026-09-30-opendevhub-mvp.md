# opendevhub MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `opendevhub`, a local CLI + web dashboard that starts one devcontainer per project, runs an opencode v2 server inside it, shows live session status with browser notifications, and opens opencode's own web UI through an authenticated `*.localhost` reverse proxy.

**Architecture:** One Node.js process. A host-routed `node:http` server serves the dashboard (Hono app: REST + SSE + static React SPA) on `localhost:<port>` and reverse-proxies `<projectId>.localhost:<port>` to the container's `opencode serve` (HTTP, SSE, WebSocket), injecting Basic auth. Shelling out (`devcontainer`, `docker`) is isolated in one adapter; a per-project `Monitor` keeps session status fresh from opencode's SSE stream plus polling; an `Orchestrator` owns lifecycle and a `StateStore` owns state.

**Tech Stack:** Node ≥ 20, TypeScript 7 (bundler resolution, extensionless imports), Hono 4 + @hono/node-server 2, React 19 + Vite 8, vitest 5, tsup 8, tsx 4, `open` 11, `ws` 8 (tests only).

**Spec:** `docs/superpowers/specs/2026-09-30-opendevhub-design.md`

## Global Constraints

- Linux only for MVP; server binds `127.0.0.1` only.
- Host prerequisites: Docker daemon, `devcontainer` CLI on `PATH`, Node ≥ 20.
- Project = directory containing `.devcontainer/devcontainer.json` or `.devcontainer.json`; roots scanned to depth 2.
- opencode must be v2 (`opencode --version` major ≥ 2), already installed in the container; opendevhub never installs it.
- opencode server: `opencode serve --hostname 0.0.0.0 --port 4096`, Basic auth user `opencode`, password via `OPENCODE_PASSWORD`.
- Container label: `opendevhub.project=<projectId>`; containers survive opendevhub exit and are re-adopted.
- Project id: DNS-label-safe, `slug(name) + "-" + sha256(path).slice(0,6)`, ≤ 63 chars.
- Default port `7777`; config in `$XDG_CONFIG_HOME/opendevhub` (fallback `~/.config/opendevhub`); `state.json` mode `0600`.
- Timeouts: `devcontainer up` 15 min, `devcontainer exec` 30 s, docker 15 s, opencode health 30 s.
- Monitor: SSE debounce 250 ms, reconcile poll every 5 s, reconnect backoff 1 s → 30 s, unhealthy after 3 consecutive failures.
- Logs: last 500 lines per project, in memory.
- Passwords are never sent to the dashboard.
- Host header must be `localhost:<port>`, `127.0.0.1:<port>` or `<projectId>.localhost:<port>` (case-insensitive); anything else → 421.
- Lifecycle actions per project are serialised; concurrent request → 409.
- Deviation from spec §8: process execution uses `node:child_process` instead of `execa` (one fewer dependency; behaviour identical).
- Imports are extensionless (`moduleResolution: bundler`); the CLI is bundled by tsup, so Node never resolves them at runtime.

## Review Focus

- **Awkward directory names** (spaces, uppercase, umlauts, CJK, 100+ chars): each must yield a valid, unique subdomain label — pinned in Task 1 tests.
- **Broken roots** (missing root, unreadable subdir, symlink loops, `.devcontainer` dir without JSON): scan must skip, warn once for a bad root, never crash — pinned in Task 3 tests.
- **`devcontainer up` failure output** (error-outcome JSON, noise-only stdout, timeout): user must see a readable message plus the tail of the log — pinned in Task 4 tests.
- **opencode UI through the proxy**: SSE must stream incrementally (not buffered until close) and a 401 must not trigger the browser's Basic-auth dialog (`www-authenticate` stripped) — pinned in Task 11 tests.
- **Notification noise**: opening the dashboard while sessions already need attention must not fire a burst of notifications, and subagent (child) sessions must roll up into their parent rather than appear as separate rows — pinned in Task 6 and Task 14 tests.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, vitest.e2e.config.ts, vite.config.ts, tsup.config.ts, .gitignore, README.md
src/shared/types.ts          shared domain + API types (server and web)
src/shared/urls.ts           projectUrl(), sessionUrl()
src/server/ids.ts            projectId()
src/server/config.ts         config/state JSON persistence, roots merging
src/server/discovery.ts      scanRoots(), findDevcontainerSpec()
src/server/exec.ts           Runner type + spawnRunner
src/server/containers.ts     Containers adapter (devcontainer/docker CLI), parseUpOutput, CommandError
src/server/opencode/client.ts  OpencodeClient (v2 HTTP + SSE)
src/server/opencode/runtime.ts OpencodeRuntime (version check, launch, health)
src/server/status.ts         deriveSessions()
src/server/state.ts          StateStore
src/server/monitor.ts        Monitor
src/server/log-buffer.ts     LogBuffer
src/server/orchestrator.ts   Orchestrator, BusyError, NotFoundError
src/server/hosts.ts          classifyHost()
src/server/proxy.ts          proxyRequest(), proxyUpgrade()
src/server/dashboard-api.ts  createDashboardApp()
src/server/server.ts         startServer()
src/server/preflight.ts      preflight()
src/server/cli.ts            parseCli(), main(), findWebDir()
src/server/bin.ts            executable entry
src/web/index.html, main.tsx, App.tsx, api.ts, useDashboard.ts, derive.ts, styles.css
src/web/components/ProjectCard.tsx, SessionRow.tsx, LogPanel.tsx
test/helpers/fake-runner.ts, test/helpers/fake-opencode.ts
test/**.test.ts              unit/integration tests mirroring src
test/e2e/opendevhub.e2e.ts, test/e2e/fixture/.devcontainer/devcontainer.json
```

---

### Task 1: Scaffold, shared types, project ids

**Files:**

- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/shared/types.ts`, `src/shared/urls.ts`, `src/server/ids.ts`
- Test: `test/server/ids.test.ts`

**Interfaces:**

- Produces: all types in `src/shared/types.ts` (used by every later task); `projectId(absPath: string): string`; `projectUrl(id: string, port: number): string`; `sessionUrl(projectBase: string, sessionId: string): string`.

- [ ] **Step 1: Create project files**

`package.json`:

```json
{
  "name": "opendevhub",
  "version": "0.1.0",
  "description": "Local dashboard to orchestrate opencode v2 agents running in devcontainers",
  "type": "module",
  "bin": { "opendevhub": "dist/bin.js" },
  "files": ["dist"],
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx src/server/bin.ts --no-open",
    "dev:web": "vite",
    "build": "vite build && tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:e2e": "OPENDEVHUB_E2E=1 vitest run -c vitest.e2e.config.ts"
  },
  "dependencies": {
    "@hono/node-server": "^2.1.3",
    "hono": "^4.13.12",
    "open": "^11.0.4"
  },
  "devDependencies": {
    "@types/node": "^26.6.3",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "@types/ws": "^8.18.2",
    "@vitejs/plugin-react": "^6.1.1",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "tsup": "^8.5.1",
    "tsx": "^4.23.15",
    "typescript": "^7.0.2",
    "vite": "^8.3.1",
    "vitest": "^5.0.3",
    "ws": "^8.22.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "verbatimModuleSyntax": true,
    "types": ["node"]
  },
  "include": ["src", "test", "*.config.ts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
```

`.gitignore`:

```
node_modules
dist
```

Run: `npm install` Expected: installs without errors.

- [ ] **Step 2: Write shared types and URL helpers**

`src/shared/types.ts`:

```ts
export type ProjectId = string;

export interface Project {
  id: ProjectId;
  name: string;
  path: string;
  devcontainerPath: string;
}

export type ContainerState =
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "error";
export type OpencodeState = "absent" | "starting" | "healthy" | "unhealthy";

export interface ProjectRuntime {
  projectId: ProjectId;
  containerId?: string;
  containerIp?: string;
  containerState: ContainerState;
  opencode: OpencodeState;
  opencodeVersion?: string;
  password?: string;
  workspaceFolder?: string;
  error?: string;
}

export type PublicRuntime = Omit<ProjectRuntime, "password">;

export type SessionStatus =
  | "idle"
  | "running"
  | "needs-permission"
  | "needs-answer";

export interface SessionSummary {
  id: string;
  projectId: ProjectId;
  title: string;
  directory: string;
  updatedAt: number;
  status: SessionStatus;
}

export interface Preflight {
  errors: string[];
}

export interface ProjectView {
  project: Project;
  runtime: PublicRuntime;
  sessions: SessionSummary[];
  openUrl: string;
}

export interface DashboardSnapshot {
  roots: string[];
  preflight: Preflight;
  projects: ProjectView[];
}

export interface LogEvent {
  projectId: ProjectId;
  line: string;
}
```

`src/shared/urls.ts`:

```ts
export function projectUrl(projectId: string, port: number): string {
  return `http://${projectId}.localhost:${port}/`;
}

/**
 * opencode's web UI routes single sessions as `/server/:serverKey/session/:id`;
 * the serverKey encoding is verified in Task 15. Until then, open the project root.
 */
export function sessionUrl(projectBase: string, _sessionId: string): string {
  return projectBase;
}
```

- [ ] **Step 3: Write the failing test for `projectId`**

`test/server/ids.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { projectId } from "../../src/server/ids";

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

describe("projectId", () => {
  it("slugs the basename and appends a 6-char path hash", () => {
    expect(projectId("/home/u/code/My App")).toMatch(/^my-app-[0-9a-f]{6}$/);
  });

  it("is stable for the same path and differs for same name in different dirs", () => {
    expect(projectId("/a/web")).toBe(projectId("/a/web"));
    expect(projectId("/a/web")).not.toBe(projectId("/b/web"));
  });

  it.each([
    "/x/Über Projekt",
    "/x/项目",
    "/x/---weird___name---",
    "/x/" + "very-long-name-".repeat(10),
    "/x/UPPER.case.Dots",
  ])("produces a valid DNS label for %s", (p) => {
    const id = projectId(p);
    expect(id).toMatch(DNS_LABEL);
    expect(id.length).toBeLessThanOrEqual(63);
  });

  it("strips diacritics instead of splitting words", () => {
    expect(projectId("/x/Über")).toMatch(/^uber-[0-9a-f]{6}$/);
  });

  it("falls back to 'project' when nothing sluggable remains", () => {
    expect(projectId("/x/项目")).toMatch(/^project-[0-9a-f]{6}$/);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run test/server/ids.test.ts` Expected: FAIL — cannot resolve `../../src/server/ids`.

- [ ] **Step 5: Implement `projectId`**

`src/server/ids.ts`:

```ts
import { createHash } from "node:crypto";
import path from "node:path";

export function projectId(absPath: string): string {
  const hash = createHash("sha256").update(absPath).digest("hex").slice(0, 6);
  const slug =
    path
      .basename(absPath)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 50)
      .replace(/-+$/g, "") || "project";
  return `${slug}-${hash}`;
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run test/server/ids.test.ts && npx tsc --noEmit` Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src test
git commit -m "feat: scaffold project, shared types and project ids"
```

---

### Task 2: Config and state persistence

**Files:**

- Create: `src/server/config.ts`
- Test: `test/server/config.test.ts`

**Interfaces:**

- Consumes: `ProjectId` from `src/shared/types`.
- Produces:
  - `interface Config { roots: string[]; port: number }`
  - `interface PersistedRuntime { containerId?: string; password?: string; workspaceFolder?: string }`
  - `interface PersistedState { projects: Record<ProjectId, PersistedRuntime> }`
  - `DEFAULT_PORT = 7777`
  - `configDir(env?: NodeJS.ProcessEnv): string`
  - `loadConfig(dir: string): Config`, `saveConfig(dir: string, cfg: Config): void`
  - `loadState(dir: string): PersistedState`, `saveState(dir: string, s: PersistedState): void`
  - `mergeRoots(existing: string[], added: string[], cwd?: string): string[]`

- [ ] **Step 1: Write the failing tests**

`test/server/config.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PORT,
  configDir,
  loadConfig,
  loadState,
  mergeRoots,
  saveConfig,
  saveState,
} from "../../src/server/config";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-config-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("configDir", () => {
  it("uses XDG_CONFIG_HOME when absolute", () => {
    expect(configDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/opendevhub");
  });
  it("falls back to ~/.config", () => {
    expect(configDir({})).toBe(
      path.join(os.homedir(), ".config", "opendevhub")
    );
  });
});

describe("config", () => {
  it("returns defaults when missing", () => {
    expect(loadConfig(dir)).toEqual({ roots: [], port: DEFAULT_PORT });
  });
  it("round-trips", () => {
    saveConfig(dir, { roots: ["/a"], port: 9000 });
    expect(loadConfig(dir)).toEqual({ roots: ["/a"], port: 9000 });
  });
  it("backs up a corrupt file and starts fresh", () => {
    fs.writeFileSync(path.join(dir, "config.json"), "{not json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(loadConfig(dir)).toEqual({ roots: [], port: DEFAULT_PORT });
    expect(fs.existsSync(path.join(dir, "config.json.bak"))).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});

describe("state", () => {
  it("round-trips and is written with mode 0600", () => {
    saveState(dir, {
      projects: {
        p1: { containerId: "c", password: "s", workspaceFolder: "/w" },
      },
    });
    expect(loadState(dir)).toEqual({
      projects: {
        p1: { containerId: "c", password: "s", workspaceFolder: "/w" },
      },
    });
    expect(fs.statSync(path.join(dir, "state.json")).mode & 0o777).toBe(0o600);
  });
  it("defaults when missing", () => {
    expect(loadState(dir)).toEqual({ projects: {} });
  });
});

describe("mergeRoots", () => {
  it("resolves, expands ~ and dedupes preserving order", () => {
    expect(mergeRoots(["/a", "/b"], ["/b", "rel", "~/code"], "/cwd")).toEqual([
      "/a",
      "/b",
      "/cwd/rel",
      path.join(os.homedir(), "code"),
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/config.test.ts` Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/config.ts`:

```ts
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
  const base =
    xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".config");
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
    console.warn(
      `opendevhub: ${file} was corrupt; moved to ${file}.bak and starting fresh`
    );
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
    roots: Array.isArray(raw.roots)
      ? raw.roots.filter((r) => typeof r === "string")
      : [],
    port: typeof raw.port === "number" ? raw.port : DEFAULT_PORT,
  };
}

export function saveConfig(dir: string, cfg: Config): void {
  writeJson(path.join(dir, "config.json"), cfg, 0o644);
}

export function loadState(dir: string): PersistedState {
  const raw = readJson<Partial<PersistedState>>(
    path.join(dir, "state.json"),
    {}
  );
  return {
    projects:
      raw.projects && typeof raw.projects === "object" ? raw.projects : {},
  };
}

export function saveState(dir: string, state: PersistedState): void {
  writeJson(path.join(dir, "state.json"), state, 0o600);
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function mergeRoots(
  existing: string[],
  added: string[],
  cwd = process.cwd()
): string[] {
  const out: string[] = [];
  for (const r of [...existing, ...added]) {
    const abs = path.resolve(cwd, expandHome(r));
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/config.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/config.ts test/server/config.test.ts
git commit -m "feat: config and state persistence"
```

---

### Task 3: Project discovery

**Files:**

- Create: `src/server/discovery.ts`
- Test: `test/server/discovery.test.ts`

**Interfaces:**

- Consumes: `projectId` (Task 1), `Project` type.
- Produces: `findDevcontainerSpec(dir: string): Promise<string | undefined>`; `scanRoots(roots: string[], maxDepth?: number, onWarn?: (msg: string) => void): Promise<Project[]>` (sorted by name, then path).

Rules: root = depth 0; a directory with a spec is a project and is not descended into; skip hidden dirs and `node_modules`; symlinked dirs are not followed (`Dirent.isDirectory()` is false for symlinks); unreadable subdirs are skipped silently; unreadable/missing roots produce one warning.

- [ ] **Step 1: Write the failing tests**

`test/server/discovery.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { scanRoots } from "../../src/server/discovery";

let root: string;
function mk(rel: string, file?: string) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (file) fs.writeFileSync(path.join(dir, file), "{}");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "odh-scan-"));
});
afterEach(() => {
  fs.chmodSync(root, 0o755);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("scanRoots", () => {
  it("finds projects at depth 1 and 2 with either spec location", async () => {
    mk("a/.devcontainer", "devcontainer.json");
    mk("org/b", ".devcontainer.json");
    const found = await scanRoots([root]);
    expect(found.map((p) => p.name)).toEqual(["a", "b"]);
    expect(found[0].devcontainerPath).toBe(
      path.join(root, "a/.devcontainer/devcontainer.json")
    );
    expect(found[1].path).toBe(path.join(root, "org/b"));
    expect(found[0].id).toMatch(/^a-[0-9a-f]{6}$/);
  });

  it("ignores depth 3, node_modules, hidden dirs and nested projects", async () => {
    mk("org/deep/c/.devcontainer", "devcontainer.json");
    mk("node_modules/x/.devcontainer", "devcontainer.json");
    mk(".hidden/y/.devcontainer", "devcontainer.json");
    mk("a/.devcontainer", "devcontainer.json");
    mk("a/sub/.devcontainer", "devcontainer.json");
    expect((await scanRoots([root])).map((p) => p.name)).toEqual(["a"]);
  });

  it("treats the root itself as a project when it has a spec", async () => {
    mk(".devcontainer", "devcontainer.json");
    expect((await scanRoots([root])).map((p) => p.path)).toEqual([root]);
  });

  it("does not treat an empty .devcontainer dir as a project", async () => {
    mk("a/.devcontainer");
    expect(await scanRoots([root])).toEqual([]);
  });

  it("dedupes overlapping roots", async () => {
    mk("org/b", ".devcontainer.json");
    const found = await scanRoots([root, path.join(root, "org")]);
    expect(found).toHaveLength(1);
  });

  it("warns once for a missing root and keeps scanning others", async () => {
    mk("a", ".devcontainer.json");
    const warn = vi.fn();
    const found = await scanRoots([path.join(root, "nope"), root], 2, warn);
    expect(found.map((p) => p.name)).toEqual(["a"]);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("skips unreadable subdirectories and does not follow symlink loops", async () => {
    mk("a", ".devcontainer.json");
    mk("locked/inner", ".devcontainer.json");
    fs.chmodSync(path.join(root, "locked"), 0o000);
    fs.symlinkSync(root, path.join(root, "loop"));
    const warn = vi.fn();
    const found = await scanRoots([root], 2, warn);
    fs.chmodSync(path.join(root, "locked"), 0o755);
    expect(found.map((p) => p.name)).toEqual(["a"]);
    expect(warn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server/discovery.test.ts` Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/discovery.ts`:

```ts
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { Project } from "../shared/types";
import { projectId } from "./ids";

const SPEC_CANDIDATES = [
  path.join(".devcontainer", "devcontainer.json"),
  ".devcontainer.json",
];
const SKIP_DIRS = new Set(["node_modules"]);

export async function findDevcontainerSpec(
  dir: string
): Promise<string | undefined> {
  for (const rel of SPEC_CANDIDATES) {
    const candidate = path.join(dir, rel);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {
      // not present or unreadable
    }
  }
  return undefined;
}

export async function scanRoots(
  roots: string[],
  maxDepth = 2,
  onWarn: (msg: string) => void = (m) => console.warn(m)
): Promise<Project[]> {
  const found = new Map<string, Project>();

  async function visit(dir: string, depth: number): Promise<void> {
    if (found.has(dir)) return;
    const spec = await findDevcontainerSpec(dir);
    if (spec) {
      found.set(dir, {
        id: projectId(dir),
        name: path.basename(dir),
        path: dir,
        devcontainerPath: spec,
      });
      return;
    }
    if (depth >= maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0)
        onWarn(
          `opendevhub: cannot read root ${dir}: ${(err as Error).message}`
        );
      return;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        SKIP_DIRS.has(entry.name)
      )
        continue;
      await visit(path.join(dir, entry.name), depth + 1);
    }
  }

  for (const root of roots) await visit(path.resolve(root), 0);
  return [...found.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  );
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/discovery.test.ts` Expected: PASS. Run tests as a normal user: root ignores `chmod 000`, so the unreadable-directory case would find `locked/inner` and fail.

- [ ] **Step 5: Commit**

```bash
git add src/server/discovery.ts test/server/discovery.test.ts
git commit -m "feat: discover devcontainer projects under roots"
```

---

### Task 4: Command runner and containers adapter

**Files:**

- Create: `src/server/exec.ts`, `src/server/containers.ts`, `test/helpers/fake-runner.ts`
- Test: `test/server/exec.test.ts`, `test/server/containers.test.ts`

**Interfaces:**

- Consumes: `Project` type.
- Produces:
  - `interface RunResult { exitCode: number; stdout: string; stderr: string; timedOut: boolean }`
  - `interface RunOptions { timeoutMs?: number; env?: Record<string, string>; onLine?: (line: string) => void }`
  - `type Runner = (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>`
  - `spawnRunner: Runner` (missing binary → `exitCode 127`)
  - `LABEL = "opendevhub.project"`
  - `class CommandError extends Error { tail: string[] }`
  - `tailLines(text: string, n?: number): string[]`
  - `interface UpResult { containerId: string; remoteWorkspaceFolder: string }`
  - `parseUpOutput(result: RunResult, fallbackFolder: string): UpResult`
  - `interface ContainerInfo { id: string; running: boolean; ip?: string; projectId?: string }`
  - `parseInspect(json: string): ContainerInfo`
  - `class Containers { constructor(run: Runner); up(project, { rebuild, onLine }): Promise<UpResult>; inspect(id): Promise<ContainerInfo | undefined>; listManaged(): Promise<ContainerInfo[]>; stop(id): Promise<void>; exec(project, command: string[], opts?: { env?: Record<string,string>; timeoutMs?: number }): Promise<RunResult> }`
  - test helper `fakeRunner(handler)` → `{ run: Runner; calls: Call[] }`

- [ ] **Step 1: Write the failing runner tests**

`test/server/exec.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { spawnRunner } from "../../src/server/exec";

const node = process.execPath;

describe("spawnRunner", () => {
  it("captures stdout, stderr and exit code", async () => {
    const r = await spawnRunner(node, [
      "-e",
      "console.log('out'); console.error('err'); process.exit(3)",
    ]);
    expect(r).toMatchObject({ exitCode: 3, timedOut: false });
    expect(r.stdout.trim()).toBe("out");
    expect(r.stderr.trim()).toBe("err");
  });

  it("streams complete lines to onLine, joining partial chunks", async () => {
    const lines: string[] = [];
    await spawnRunner(
      node,
      [
        "-e",
        "process.stdout.write('a\\nb'); setTimeout(() => process.stdout.write('c\\n'), 20)",
      ],
      { onLine: (l) => lines.push(l) }
    );
    expect(lines).toEqual(["a", "bc"]);
  });

  it("reports a missing binary as exit code 127", async () => {
    const r = await spawnRunner("opendevhub-no-such-binary", []);
    expect(r.exitCode).toBe(127);
  });

  it("kills the process on timeout", async () => {
    const r = await spawnRunner(node, ["-e", "setTimeout(() => {}, 10000)"], {
      timeoutMs: 200,
    });
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0);
  });

  it("passes extra env vars", async () => {
    const r = await spawnRunner(
      node,
      ["-e", "console.log(process.env.ODH_FOO)"],
      { env: { ODH_FOO: "bar" } }
    );
    expect(r.stdout.trim()).toBe("bar");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/exec.test.ts` Expected: FAIL — module not found.

- [ ] **Step 3: Implement the runner**

`src/server/exec.ts`:

```ts
import { spawn } from "node:child_process";

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  onLine?: (line: string) => void;
}

export type Runner = (
  cmd: string,
  args: string[],
  opts?: RunOptions
) => Promise<RunResult>;

export const spawnRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const carry = { out: "", err: "" };
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const feed = (key: "out" | "err", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (key === "out") stdout += text;
      else stderr += text;
      if (!opts.onLine) return;
      const parts = (carry[key] + text).split(/\r?\n/);
      carry[key] = parts.pop() ?? "";
      for (const line of parts) if (line.trim()) opts.onLine(line);
    };
    child.stdout.on("data", (c: Buffer) => feed("out", c));
    child.stderr.on("data", (c: Buffer) => feed("err", c));

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 5000).unref();
        }, opts.timeoutMs)
      : undefined;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.onLine)
        for (const rest of [carry.out, carry.err])
          if (rest.trim()) opts.onLine(rest);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    child.on("error", (err) => {
      stderr += err.message;
      finish(127);
    });
    child.on("close", (code) => finish(code ?? 1));
  });
```

- [ ] **Step 4: Run runner tests**

Run: `npx vitest run test/server/exec.test.ts` Expected: PASS.

- [ ] **Step 5: Write the fake runner helper and failing containers tests**

`test/helpers/fake-runner.ts`:

```ts
import type { RunOptions, RunResult, Runner } from "../../src/server/exec";

export interface Call {
  cmd: string;
  args: string[];
  opts?: RunOptions;
}

export function fakeRunner(
  handler: (
    call: Call
  ) => Partial<RunResult> | Promise<Partial<RunResult>> = () => ({})
) {
  const calls: Call[] = [];
  const run: Runner = async (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    const r = await handler(call);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...r };
  };
  return { run, calls };
}
```

`test/server/containers.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  CommandError,
  Containers,
  LABEL,
  parseUpOutput,
} from "../../src/server/containers";
import type { Project } from "../../src/shared/types";
import { fakeRunner } from "../helpers/fake-runner";

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
  State: { Running: true },
  Config: { Labels: { [LABEL]: "demo-1a2b3c" } },
  NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.5" } } },
});

describe("parseUpOutput", () => {
  const base = { exitCode: 0, stderr: "", timedOut: false };
  it("parses the success line", () => {
    expect(parseUpOutput({ ...base, stdout: okUp }, "/fallback")).toEqual({
      containerId: "abc123",
      remoteWorkspaceFolder: "/workspaces/demo",
    });
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
    } catch (err) {
      expect(err).toBeInstanceOf(CommandError);
      expect((err as Error).message).toMatch(/Command failed: docker build/);
      expect((err as CommandError).tail).toEqual(["step 1", "boom"]);
    }
  });
  it("reports timeouts", () => {
    expect(() =>
      parseUpOutput({ ...base, exitCode: 1, stdout: "", timedOut: true }, "/f")
    ).toThrow(/timed out/);
  });
  it("reports missing result JSON with exit code", () => {
    expect(() =>
      parseUpOutput(
        { ...base, exitCode: 1, stdout: "noise only", stderr: "x" },
        "/f"
      )
    ).toThrow(/exited with code 1/);
  });
  it("falls back when remoteWorkspaceFolder is absent", () => {
    const stdout = '{"outcome":"success","containerId":"c"}';
    expect(
      parseUpOutput({ ...base, stdout }, "/workspaces/demo")
        .remoteWorkspaceFolder
    ).toBe("/workspaces/demo");
  });
});

describe("Containers", () => {
  it("up passes workspace folder and id label, streams lines", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: okUp }));
    const lines: string[] = [];
    const res = await new Containers(run).up(project, {
      rebuild: false,
      onLine: (l) => lines.push(l),
    });
    expect(res.containerId).toBe("abc123");
    expect(calls[0].cmd).toBe("devcontainer");
    expect(calls[0].args).toEqual([
      "up",
      "--workspace-folder",
      "/src/demo",
      "--id-label",
      `${LABEL}=demo-1a2b3c`,
    ]);
    calls[0].opts?.onLine?.("hello");
    expect(lines).toEqual(["hello"]);
  });

  it("up with rebuild removes the existing container", async () => {
    const { run, calls } = fakeRunner(() => ({ stdout: okUp }));
    await new Containers(run).up(project, { rebuild: true, onLine: () => {} });
    expect(calls[0].args).toContain("--remove-existing-container");
  });

  it("inspect parses state, ip and label; undefined on failure", async () => {
    const ok = fakeRunner(() => ({ stdout: inspectJson + "\n" }));
    expect(await new Containers(ok.run).inspect("abc123")).toEqual({
      id: "abc123",
      running: true,
      ip: "172.17.0.5",
      projectId: "demo-1a2b3c",
    });
    const missing = fakeRunner(() => ({
      exitCode: 1,
      stderr: "No such container",
    }));
    expect(await new Containers(missing.run).inspect("nope")).toBeUndefined();
  });

  it("listManaged filters by label and inspects each id", async () => {
    const { run, calls } = fakeRunner((c) =>
      c.args[0] === "ps" ? { stdout: "abc123\n" } : { stdout: inspectJson }
    );
    const list = await new Containers(run).listManaged();
    expect(calls[0].args).toEqual([
      "ps",
      "-a",
      "--filter",
      `label=${LABEL}`,
      "--format",
      "{{.ID}}",
    ]);
    expect(list.map((c) => c.id)).toEqual(["abc123"]);
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
    expect(calls[0].args).toEqual([
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
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run test/server/containers.test.ts` Expected: FAIL — module not found.

- [ ] **Step 7: Implement the containers adapter**

`src/server/containers.ts`:

```ts
import path from "node:path";

import type { Project } from "../shared/types";
import type { RunResult, Runner } from "./exec";

export const LABEL = "opendevhub.project";
const UP_TIMEOUT_MS = 15 * 60_000;
const EXEC_TIMEOUT_MS = 30_000;
const DOCKER_TIMEOUT_MS = 15_000;

export class CommandError extends Error {
  constructor(
    message: string,
    readonly tail: string[] = []
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export function tailLines(text: string, n = 20): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "")
    .slice(-n);
}

export interface UpResult {
  containerId: string;
  remoteWorkspaceFolder: string;
}

export function parseUpOutput(
  result: RunResult,
  fallbackFolder: string
): UpResult {
  const candidates = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"));
  for (let i = candidates.length - 1; i >= 0; i--) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(candidates[i]) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      parsed.outcome === "success" &&
      typeof parsed.containerId === "string"
    ) {
      return {
        containerId: parsed.containerId,
        remoteWorkspaceFolder:
          typeof parsed.remoteWorkspaceFolder === "string"
            ? parsed.remoteWorkspaceFolder
            : fallbackFolder,
      };
    }
    if (typeof parsed.outcome === "string") {
      const reason = parsed.message ?? parsed.description ?? "unknown error";
      throw new CommandError(
        `devcontainer up failed: ${String(reason)}`,
        tailLines(result.stderr)
      );
    }
  }
  if (result.timedOut)
    throw new CommandError(
      "devcontainer up timed out after 15 minutes",
      tailLines(result.stderr)
    );
  throw new CommandError(
    `devcontainer up exited with code ${result.exitCode} without a result`,
    tailLines(`${result.stderr}\n${result.stdout}`)
  );
}

export interface ContainerInfo {
  id: string;
  running: boolean;
  ip?: string;
  projectId?: string;
}

export function parseInspect(json: string): ContainerInfo {
  const c = JSON.parse(json) as {
    Id: string;
    State?: { Running?: boolean };
    Config?: { Labels?: Record<string, string> | null };
    NetworkSettings?: { Networks?: Record<string, { IPAddress?: string }> };
  };
  const ip = Object.values(c.NetworkSettings?.Networks ?? {})
    .map((n) => n.IPAddress)
    .find((a): a is string => !!a);
  return {
    id: c.Id,
    running: c.State?.Running === true,
    ip,
    projectId: c.Config?.Labels?.[LABEL],
  };
}

export class Containers {
  constructor(private readonly run: Runner) {}

  private idArgs(project: Project): string[] {
    return [
      "--workspace-folder",
      project.path,
      "--id-label",
      `${LABEL}=${project.id}`,
    ];
  }

  async up(
    project: Project,
    opts: { rebuild: boolean; onLine: (line: string) => void }
  ): Promise<UpResult> {
    const args = ["up", ...this.idArgs(project)];
    if (opts.rebuild) args.push("--remove-existing-container");
    const result = await this.run("devcontainer", args, {
      timeoutMs: UP_TIMEOUT_MS,
      onLine: opts.onLine,
    });
    return parseUpOutput(result, `/workspaces/${path.basename(project.path)}`);
  }

  async inspect(containerId: string): Promise<ContainerInfo | undefined> {
    const r = await this.run(
      "docker",
      ["inspect", "--type", "container", "--format", "{{json .}}", containerId],
      {
        timeoutMs: DOCKER_TIMEOUT_MS,
      }
    );
    if (r.exitCode !== 0) return undefined;
    return parseInspect(r.stdout.trim());
  }

  async listManaged(): Promise<ContainerInfo[]> {
    const r = await this.run(
      "docker",
      ["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.ID}}"],
      {
        timeoutMs: DOCKER_TIMEOUT_MS,
      }
    );
    if (r.exitCode !== 0)
      throw new CommandError(
        `docker ps failed: ${r.stderr.trim()}`,
        tailLines(r.stderr)
      );
    const ids = r.stdout.split(/\s+/).filter(Boolean);
    const infos = await Promise.all(ids.map((id) => this.inspect(id)));
    return infos.filter((i): i is ContainerInfo => i !== undefined);
  }

  async stop(containerId: string): Promise<void> {
    const r = await this.run("docker", ["stop", "-t", "10", containerId], {
      timeoutMs: 30_000,
    });
    if (r.exitCode !== 0)
      throw new CommandError(
        `docker stop failed: ${r.stderr.trim()}`,
        tailLines(r.stderr)
      );
  }

  exec(
    project: Project,
    command: string[],
    opts: { env?: Record<string, string>; timeoutMs?: number } = {}
  ): Promise<RunResult> {
    const args = ["exec", ...this.idArgs(project)];
    for (const [k, v] of Object.entries(opts.env ?? {}))
      args.push("--remote-env", `${k}=${v}`);
    return this.run("devcontainer", [...args, ...command], {
      timeoutMs: opts.timeoutMs ?? EXEC_TIMEOUT_MS,
    });
  }
}
```

- [ ] **Step 8: Run tests**

Run: `npx vitest run test/server/exec.test.ts test/server/containers.test.ts` Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server/exec.ts src/server/containers.ts test/helpers/fake-runner.ts test/server/exec.test.ts test/server/containers.test.ts
git commit -m "feat: command runner and devcontainer/docker adapter"
```

---

### Task 5: opencode v2 client and fake server

**Files:**

- Create: `src/server/opencode/client.ts`, `test/helpers/fake-opencode.ts`
- Test: `test/server/opencode-client.test.ts`

**Interfaces:**

- Produces:
  - `interface OpencodeEndpoint { baseUrl: string; password: string }`
  - `interface RawSession { id: string; title?: string; parentID?: string; time: { created: number; updated: number; archived?: number }; location: { directory: string } }`
  - `interface RawPermissionRequest { id: string; sessionID: string; action: string }`
  - `interface RawForm { id: string; sessionID: string; title: string }`
  - `interface OpencodeEvent { type: string; location?: { directory: string }; data?: Record<string, unknown> }`
  - `basicAuth(password: string): string`
  - `class OpencodeHttpError extends Error { status: number }`
  - `class OpencodeClient { constructor(ep, fetchImpl?); info(): Promise<{ version: string }>; sessions(): Promise<RawSession[]>; active(): Promise<Set<string>>; permissionRequests(directory: string): Promise<RawPermissionRequest[]>; forms(directory: string): Promise<RawForm[]>; subscribe(onEvent, signal): Promise<void> }`
  - test helper `startFakeOpencode(password?, init?)` → `{ state, requests, baseUrl, port, emit(event), dropStreams(), sseClientCount(), close() }`

Verified against opencode 2.0.20: `/api/session` returns `{ data: Session[], cursor }` server-wide; `/api/session/active` returns `{ data: { [id]: { type: "running" } } }`; `/api/permission/request` and `/api/form` are scoped to a directory given by the `x-opencode-directory` header (default: server cwd) and return `{ location, data: [] }`; `/api/event` is SSE with `data: {json}` blocks and `: heartbeat` comments.

- [ ] **Step 1: Write the fake opencode server**

`test/helpers/fake-opencode.ts`:

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";

import type {
  RawForm,
  RawPermissionRequest,
  RawSession,
} from "../../src/server/opencode/client";

export interface FakeState {
  version: string;
  cwd: string;
  sessions: RawSession[];
  active: string[];
  permissions: Record<string, RawPermissionRequest[]>;
  forms: Record<string, RawForm[]>;
  fail: boolean;
}

export async function startFakeOpencode(
  password = "pw",
  init: Partial<FakeState> = {}
) {
  const state: FakeState = {
    version: "2.0.20",
    cwd: "/workspaces/demo",
    sessions: [],
    active: [],
    permissions: {},
    forms: {},
    fail: false,
    ...init,
  };
  const sseClients = new Set<http.ServerResponse>();
  const requests: string[] = [];
  const expected =
    "Basic " + Buffer.from(`opencode:${password}`).toString("base64");

  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== expected) {
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Basic realm="Secure Area"',
      });
      res.end('{"_tag":"UnauthorizedError"}');
      return;
    }
    if (state.fail) {
      res.writeHead(500);
      res.end();
      return;
    }
    const url = new URL(req.url ?? "/", "http://fake");
    const dir =
      (req.headers["x-opencode-directory"] as string | undefined) ?? state.cwd;
    const json = (body: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    switch (url.pathname) {
      case "/api/info":
        return json({ version: state.version, pid: 1, urls: [], paths: {} });
      case "/api/session":
        return json({ data: state.sessions, cursor: {} });
      case "/api/session/active":
        return json({
          data: Object.fromEntries(
            state.active.map((id) => [id, { type: "running" }])
          ),
        });
      case "/api/permission/request":
        return json({
          location: { directory: dir },
          data: state.permissions[dir] ?? [],
        });
      case "/api/form":
        return json({
          location: { directory: dir },
          data: state.forms[dir] ?? [],
        });
      case "/api/event":
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write(
          `data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`
        );
        res.write(": heartbeat\n\n");
        sseClients.add(res);
        req.on("close", () => sseClients.delete(res));
        return;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    state,
    requests,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    emit(event: object) {
      for (const c of sseClients) c.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    dropStreams() {
      for (const c of sseClients) c.destroy();
      sseClients.clear();
    },
    sseClientCount: () => sseClients.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of sseClients) c.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type FakeOpencode = Awaited<ReturnType<typeof startFakeOpencode>>;

export function rawSession(
  id: string,
  over: Partial<RawSession> = {}
): RawSession {
  return {
    id,
    title: `Session ${id}`,
    time: { created: 1, updated: 1 },
    location: { directory: "/workspaces/demo" },
    ...over,
  };
}
```

- [ ] **Step 2: Write the failing client tests**

`test/server/opencode-client.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OpencodeClient,
  OpencodeHttpError,
  type OpencodeEvent,
} from "../../src/server/opencode/client";
import {
  type FakeOpencode,
  rawSession,
  startFakeOpencode,
} from "../helpers/fake-opencode";

let fake: FakeOpencode;
let client: OpencodeClient;
beforeEach(async () => {
  fake = await startFakeOpencode("pw");
  client = new OpencodeClient({ baseUrl: fake.baseUrl, password: "pw" });
});
afterEach(() => fake.close());

describe("OpencodeClient", () => {
  it("reads info with basic auth", async () => {
    expect((await client.info()).version).toBe("2.0.20");
  });

  it("throws OpencodeHttpError with status on wrong password", async () => {
    const bad = new OpencodeClient({ baseUrl: fake.baseUrl, password: "nope" });
    await expect(bad.info()).rejects.toMatchObject({ status: 401 });
    await expect(bad.info()).rejects.toBeInstanceOf(OpencodeHttpError);
  });

  it("lists sessions and active ids", async () => {
    fake.state.sessions = [rawSession("ses_1")];
    fake.state.active = ["ses_1"];
    expect((await client.sessions()).map((s) => s.id)).toEqual(["ses_1"]);
    expect(await client.active()).toEqual(new Set(["ses_1"]));
  });

  it("scopes permission requests and forms by directory header", async () => {
    fake.state.permissions["/w/other"] = [
      { id: "per_1", sessionID: "ses_1", action: "bash" },
    ];
    fake.state.forms["/w/other"] = [
      { id: "frm_1", sessionID: "ses_2", title: "Q" },
    ];
    expect(await client.permissionRequests("/workspaces/demo")).toEqual([]);
    expect(
      (await client.permissionRequests("/w/other")).map((p) => p.id)
    ).toEqual(["per_1"]);
    expect((await client.forms("/w/other")).map((f) => f.id)).toEqual([
      "frm_1",
    ]);
  });

  it("streams parsed SSE events, skipping comments, until aborted", async () => {
    const events: OpencodeEvent[] = [];
    const ac = new AbortController();
    const done = client
      .subscribe((e) => events.push(e), ac.signal)
      .catch(() => {});
    await expect.poll(() => fake.sseClientCount()).toBe(1);
    fake.emit({ type: "session.created", data: { sessionID: "ses_9" } });
    await expect
      .poll(() => events.map((e) => e.type))
      .toEqual(["server.connected", "session.created"]);
    ac.abort();
    await done;
  });

  it("subscribe rejects on auth failure", async () => {
    const bad = new OpencodeClient({ baseUrl: fake.baseUrl, password: "nope" });
    await expect(
      bad.subscribe(() => {}, new AbortController().signal)
    ).rejects.toMatchObject({ status: 401 });
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/server/opencode-client.test.ts` Expected: FAIL — module not found.

- [ ] **Step 4: Implement the client**

`src/server/opencode/client.ts`:

```ts
export interface OpencodeEndpoint {
  baseUrl: string;
  password: string;
}

export interface RawSession {
  id: string;
  title?: string;
  parentID?: string;
  time: { created: number; updated: number; archived?: number };
  location: { directory: string };
}

export interface RawPermissionRequest {
  id: string;
  sessionID: string;
  action: string;
}

export interface RawForm {
  id: string;
  sessionID: string;
  title: string;
}

export interface OpencodeEvent {
  type: string;
  location?: { directory: string };
  data?: Record<string, unknown>;
}

export class OpencodeHttpError extends Error {
  constructor(
    readonly status: number,
    path: string
  ) {
    super(`opencode ${path} responded ${status}`);
    this.name = "OpencodeHttpError";
  }
}

export function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

const REQUEST_TIMEOUT_MS = 5000;

export class OpencodeClient {
  constructor(
    private readonly ep: OpencodeEndpoint,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  private async get<T>(path: string, directory?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: basicAuth(this.ep.password),
      accept: "application/json",
    };
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchImpl(this.ep.baseUrl + path, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new OpencodeHttpError(res.status, path);
    return (await res.json()) as T;
  }

  info(): Promise<{ version: string }> {
    return this.get("/api/info");
  }

  async sessions(): Promise<RawSession[]> {
    return (await this.get<{ data: RawSession[] }>("/api/session")).data;
  }

  async active(): Promise<Set<string>> {
    const r = await this.get<{ data: Record<string, unknown> }>(
      "/api/session/active"
    );
    return new Set(Object.keys(r.data));
  }

  async permissionRequests(directory: string): Promise<RawPermissionRequest[]> {
    return (
      await this.get<{ data: RawPermissionRequest[] }>(
        "/api/permission/request",
        directory
      )
    ).data;
  }

  async forms(directory: string): Promise<RawForm[]> {
    return (await this.get<{ data: RawForm[] }>("/api/form", directory)).data;
  }

  /** Resolves when the stream ends; rejects on HTTP or network errors (including abort). */
  async subscribe(
    onEvent: (event: OpencodeEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const res = await this.fetchImpl(this.ep.baseUrl + "/api/event", {
      headers: {
        authorization: basicAuth(this.ep.password),
        accept: "text/event-stream",
      },
      signal,
    });
    if (!res.ok || !res.body)
      throw new OpencodeHttpError(res.status, "/api/event");
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          onEvent(JSON.parse(data) as OpencodeEvent);
        } catch {
          // ignore malformed event payloads
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/server/opencode-client.test.ts` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/opencode/client.ts test/helpers/fake-opencode.ts test/server/opencode-client.test.ts
git commit -m "feat: opencode v2 HTTP/SSE client with fake server"
```

---

### Task 6: Session status derivation

**Files:**

- Create: `src/server/status.ts`
- Test: `test/server/status.test.ts`

**Interfaces:**

- Consumes: `RawSession`, `RawPermissionRequest`, `RawForm` (Task 5); `SessionSummary`, `SessionStatus` types.
- Produces:
  - `interface StatusInput { sessions: RawSession[]; active: Set<string>; permissions: RawPermissionRequest[]; forms: RawForm[] }`
  - `deriveSessions(projectId: string, input: StatusInput): SessionSummary[]` — top-level, non-archived sessions only; child session signals roll up to their root ancestor; precedence `needs-permission > needs-answer > running > idle`; sorted by status rank then `updatedAt` desc.
  - `compareSessions(a: SessionSummary, b: SessionSummary): number`

- [ ] **Step 1: Write the failing tests**

`test/server/status.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { deriveSessions } from "../../src/server/status";
import { rawSession } from "../helpers/fake-opencode";

const base = { active: new Set<string>(), permissions: [], forms: [] };

describe("deriveSessions", () => {
  it("maps sessions to idle summaries with titles and directories", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [rawSession("ses_1", { title: "  " })],
    });
    expect(out).toEqual([
      {
        id: "ses_1",
        projectId: "p",
        title: "Untitled session",
        directory: "/workspaces/demo",
        updatedAt: 1,
        status: "idle",
      },
    ]);
  });

  it("applies precedence permission > answer > running", () => {
    const out = deriveSessions("p", {
      sessions: [rawSession("a"), rawSession("b"), rawSession("c")],
      active: new Set(["a", "b", "c"]),
      forms: [
        { id: "f1", sessionID: "a", title: "q" },
        { id: "f2", sessionID: "b", title: "q" },
      ],
      permissions: [{ id: "p1", sessionID: "a", action: "bash" }],
    });
    expect(Object.fromEntries(out.map((s) => [s.id, s.status]))).toEqual({
      a: "needs-permission",
      b: "needs-answer",
      c: "running",
    });
  });

  it("rolls child (subagent) sessions up into their root parent and hides them", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("root"),
        rawSession("child", { parentID: "root" }),
        rawSession("grand", { parentID: "child" }),
      ],
      permissions: [{ id: "p1", sessionID: "grand", action: "edit" }],
    });
    expect(out.map((s) => [s.id, s.status])).toEqual([
      ["root", "needs-permission"],
    ]);
  });

  it("survives parent cycles", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("x", { parentID: "y" }),
        rawSession("y", { parentID: "x" }),
      ],
      active: new Set(["x"]),
    });
    expect(out).toEqual([]);
  });

  it("hides archived sessions", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("a", { time: { created: 1, updated: 1, archived: 2 } }),
      ],
    });
    expect(out).toEqual([]);
  });

  it("sorts attention first, then most recently updated", () => {
    const out = deriveSessions("p", {
      ...base,
      sessions: [
        rawSession("old", { time: { created: 1, updated: 10 } }),
        rawSession("new", { time: { created: 1, updated: 20 } }),
        rawSession("ask", { time: { created: 1, updated: 5 } }),
      ],
      forms: [{ id: "f", sessionID: "ask", title: "?" }],
    });
    expect(out.map((s) => s.id)).toEqual(["ask", "new", "old"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/status.test.ts` Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/status.ts`:

```ts
import type { SessionStatus, SessionSummary } from "../shared/types";
import type {
  RawForm,
  RawPermissionRequest,
  RawSession,
} from "./opencode/client";

export interface StatusInput {
  sessions: RawSession[];
  active: Set<string>;
  permissions: RawPermissionRequest[];
  forms: RawForm[];
}

const RANK: Record<SessionStatus, number> = {
  "needs-permission": 0,
  "needs-answer": 1,
  running: 2,
  idle: 3,
};

export function compareSessions(a: SessionSummary, b: SessionSummary): number {
  return RANK[a.status] - RANK[b.status] || b.updatedAt - a.updatedAt;
}

function rootOf(id: string, parents: Map<string, string | undefined>): string {
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const parent = parents.get(current);
    if (!parent) return current;
    current = parent;
  }
  return current;
}

export function deriveSessions(
  projectId: string,
  input: StatusInput
): SessionSummary[] {
  const parents = new Map(input.sessions.map((s) => [s.id, s.parentID]));
  const flags = new Map<string, SessionStatus>();
  const raise = (sessionId: string, status: SessionStatus) => {
    const root = rootOf(sessionId, parents);
    const current = flags.get(root);
    if (!current || RANK[status] < RANK[current]) flags.set(root, status);
  };
  for (const id of input.active) raise(id, "running");
  for (const f of input.forms) raise(f.sessionID, "needs-answer");
  for (const p of input.permissions) raise(p.sessionID, "needs-permission");

  return input.sessions
    .filter((s) => !s.parentID && s.time.archived === undefined)
    .map((s) => ({
      id: s.id,
      projectId,
      title: s.title?.trim() || "Untitled session",
      directory: s.location.directory,
      updatedAt: s.time.updated,
      status: flags.get(s.id) ?? "idle",
    }))
    .sort(compareSessions);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/status.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/status.ts test/server/status.test.ts
git commit -m "feat: derive session status with subagent roll-up"
```

---

### Task 7: State store

**Files:**

- Create: `src/server/state.ts`
- Test: `test/server/state.test.ts`

**Interfaces:**

- Consumes: `PersistedState` (Task 2), `projectUrl` (Task 1), shared types.
- Produces:
  - `interface StoreOptions { port: number; persisted: PersistedState; persist: (s: PersistedState) => void }`
  - `class StateStore { constructor(opts); setProjects(list: Project[]): void; projects(): Project[]; project(id): Project | undefined; runtime(id): ProjectRuntime; updateRuntime(id, patch: Partial<ProjectRuntime>): void; setSessions(id, list: SessionSummary[]): void; setRoots(roots: string[]): void; setPreflight(p: Preflight): void; preflight(): Preflight; snapshot(): DashboardSnapshot; subscribe(fn: () => void): () => void }`
  - Change events only fire when something actually changed. Persist only when `containerId`, `password` or `workspaceFolder` changes.

- [ ] **Step 1: Write the failing tests**

`test/server/state.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { PersistedState } from "../../src/server/config";
import { StateStore } from "../../src/server/state";
import type { Project, SessionSummary } from "../../src/shared/types";

const p = (id: string): Project => ({
  id,
  name: id,
  path: `/src/${id}`,
  devcontainerPath: `/src/${id}/.devcontainer.json`,
});
const session: SessionSummary = {
  id: "s1",
  projectId: "a",
  title: "t",
  directory: "/w",
  updatedAt: 1,
  status: "idle",
};

function make(persisted: PersistedState = { projects: {} }) {
  const saved: PersistedState[] = [];
  const store = new StateStore({
    port: 7777,
    persisted,
    persist: (s) => saved.push(structuredClone(s)),
  });
  return { store, saved };
}

describe("StateStore", () => {
  it("gives new projects a stopped runtime and restores persisted fields", () => {
    const { store } = make({
      projects: {
        b: { containerId: "c9", password: "pw", workspaceFolder: "/w" },
      },
    });
    store.setProjects([p("a"), p("b")]);
    expect(store.runtime("a")).toEqual({
      projectId: "a",
      containerState: "stopped",
      opencode: "absent",
    });
    expect(store.runtime("b")).toMatchObject({
      containerId: "c9",
      password: "pw",
      workspaceFolder: "/w",
    });
  });

  it("persists only durable fields, and only when they change", () => {
    const { store, saved } = make();
    store.setProjects([p("a")]);
    store.updateRuntime("a", { containerState: "starting" });
    expect(saved).toHaveLength(0);
    store.updateRuntime("a", { containerId: "c1", password: "pw" });
    expect(saved.at(-1)).toEqual({
      projects: {
        a: { containerId: "c1", password: "pw", workspaceFolder: undefined },
      },
    });
  });

  it("notifies subscribers on change but not on no-op updates", () => {
    const { store } = make();
    store.setProjects([p("a")]);
    const fn = vi.fn();
    const off = store.subscribe(fn);
    store.updateRuntime("a", { containerState: "stopped" });
    store.setSessions("a", []);
    expect(fn).not.toHaveBeenCalled();
    store.setSessions("a", [session]);
    store.setSessions("a", [{ ...session }]);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    store.updateRuntime("a", { containerState: "running" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("snapshot omits passwords and includes open urls, roots and preflight", () => {
    const { store } = make();
    store.setRoots(["/src"]);
    store.setPreflight({ errors: ["no docker"] });
    store.setProjects([p("a")]);
    store.updateRuntime("a", { password: "secret" });
    const snap = store.snapshot();
    expect(JSON.stringify(snap)).not.toContain("secret");
    expect(snap).toMatchObject({
      roots: ["/src"],
      preflight: { errors: ["no docker"] },
      projects: [
        {
          project: { id: "a" },
          openUrl: "http://a.localhost:7777/",
          sessions: [],
        },
      ],
    });
  });

  it("drops projects that disappear from a rescan", () => {
    const { store } = make();
    store.setProjects([p("a"), p("b")]);
    store.setProjects([p("b")]);
    expect(store.snapshot().projects.map((v) => v.project.id)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/state.test.ts` Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/state.ts`:

```ts
import type {
  DashboardSnapshot,
  Preflight,
  Project,
  ProjectId,
  ProjectRuntime,
  SessionSummary,
} from "../shared/types";
import { projectUrl } from "../shared/urls";
import type { PersistedRuntime, PersistedState } from "./config";

export interface StoreOptions {
  port: number;
  persisted: PersistedState;
  persist: (state: PersistedState) => void;
}

const DURABLE_KEYS = ["containerId", "password", "workspaceFolder"] as const;

function defaultRuntime(projectId: ProjectId): ProjectRuntime {
  return { projectId, containerState: "stopped", opencode: "absent" };
}

export class StateStore {
  private projectsById = new Map<ProjectId, Project>();
  private runtimes = new Map<ProjectId, ProjectRuntime>();
  private sessions = new Map<ProjectId, SessionSummary[]>();
  private listeners = new Set<() => void>();
  private roots: string[] = [];
  private preflightState: Preflight = { errors: [] };

  constructor(private readonly opts: StoreOptions) {
    for (const [id, saved] of Object.entries(opts.persisted.projects)) {
      this.runtimes.set(id, { ...defaultRuntime(id), ...saved });
    }
  }

  setProjects(list: Project[]): void {
    this.projectsById = new Map(list.map((p) => [p.id, p]));
    for (const p of list)
      if (!this.runtimes.has(p.id))
        this.runtimes.set(p.id, defaultRuntime(p.id));
    this.emit();
  }

  projects(): Project[] {
    return [...this.projectsById.values()];
  }

  project(id: ProjectId): Project | undefined {
    return this.projectsById.get(id);
  }

  runtime(id: ProjectId): ProjectRuntime {
    return this.runtimes.get(id) ?? defaultRuntime(id);
  }

  updateRuntime(id: ProjectId, patch: Partial<ProjectRuntime>): void {
    const current = this.runtime(id);
    const changed = (Object.keys(patch) as (keyof ProjectRuntime)[]).filter(
      (k) => current[k] !== patch[k]
    );
    if (changed.length === 0) return;
    this.runtimes.set(id, { ...current, ...patch });
    if (changed.some((k) => (DURABLE_KEYS as readonly string[]).includes(k)))
      this.save();
    this.emit();
  }

  setSessions(id: ProjectId, list: SessionSummary[]): void {
    const current = this.sessions.get(id) ?? [];
    if (JSON.stringify(current) === JSON.stringify(list)) return;
    this.sessions.set(id, list);
    this.emit();
  }

  setRoots(roots: string[]): void {
    this.roots = [...roots];
    this.emit();
  }

  setPreflight(preflight: Preflight): void {
    this.preflightState = preflight;
    this.emit();
  }

  preflight(): Preflight {
    return this.preflightState;
  }

  snapshot(): DashboardSnapshot {
    return {
      roots: this.roots,
      preflight: this.preflightState,
      projects: this.projects().map((project) => {
        const { password: _password, ...runtime } = this.runtime(project.id);
        return {
          project,
          runtime,
          sessions: this.sessions.get(project.id) ?? [],
          openUrl: projectUrl(project.id, this.opts.port),
        };
      }),
    };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private save(): void {
    const projects: Record<ProjectId, PersistedRuntime> = {};
    for (const [id, r] of this.runtimes) {
      if (r.containerId || r.password || r.workspaceFolder) {
        projects[id] = {
          containerId: r.containerId,
          password: r.password,
          workspaceFolder: r.workspaceFolder,
        };
      }
    }
    this.opts.persist({ projects });
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/state.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/state.ts test/server/state.test.ts
git commit -m "feat: state store with change notifications and persistence"
```

---

### Task 8: Monitor

**Files:**

- Create: `src/server/monitor.ts`
- Test: `test/server/monitor.test.ts`

**Interfaces:**

- Consumes: `OpencodeClient` (Task 5), `deriveSessions` (Task 6).
- Produces:
  - `interface MonitorOptions { client: OpencodeClient; projectId: string; directory: string; onSessions: (s: SessionSummary[]) => void; onHealth: (healthy: boolean) => void; pollMs?: number; debounceMs?: number; minBackoffMs?: number; maxBackoffMs?: number }`
  - `class Monitor { constructor(opts); start(): void; stop(): void; reconcile(): Promise<void> }`
  - Relevant event types: `/^(session|permission|form)\./`. `onHealth(false)` after 3 consecutive failed reconciles; `onHealth(true)` on every success.

- [ ] **Step 1: Write the failing tests**

`test/server/monitor.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Monitor, type MonitorOptions } from "../../src/server/monitor";
import { OpencodeClient } from "../../src/server/opencode/client";
import type { SessionSummary } from "../../src/shared/types";
import {
  type FakeOpencode,
  rawSession,
  startFakeOpencode,
} from "../helpers/fake-opencode";

let fake: FakeOpencode;
let monitor: Monitor | undefined;
let latest: SessionSummary[] | undefined;
let health: boolean[];

beforeEach(async () => {
  fake = await startFakeOpencode("pw");
  latest = undefined;
  health = [];
});
afterEach(async () => {
  monitor?.stop();
  await fake.close();
});

function start(over: Partial<MonitorOptions> = {}) {
  monitor = new Monitor({
    client: new OpencodeClient({ baseUrl: fake.baseUrl, password: "pw" }),
    projectId: "p",
    directory: "/workspaces/demo",
    onSessions: (s) => (latest = s),
    onHealth: (h) => health.push(h),
    pollMs: 60_000,
    debounceMs: 10,
    minBackoffMs: 20,
    maxBackoffMs: 50,
    ...over,
  });
  monitor.start();
}

describe("Monitor", () => {
  it("reconciles immediately on start", async () => {
    fake.state.sessions = [rawSession("ses_1")];
    fake.state.active = ["ses_1"];
    start();
    await vi.waitFor(() =>
      expect(latest?.map((s) => s.status)).toEqual(["running"])
    );
    expect(health).toContain(true);
  });

  it("reconciles shortly after a relevant SSE event", async () => {
    fake.state.sessions = [rawSession("ses_1")];
    start();
    await vi.waitFor(() => expect(latest?.[0].status).toBe("idle"));
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    fake.state.permissions["/workspaces/demo"] = [
      { id: "per_1", sessionID: "ses_1", action: "bash" },
    ];
    fake.emit({ type: "permission.asked", data: { sessionID: "ses_1" } });
    await vi.waitFor(
      () => expect(latest?.[0].status).toBe("needs-permission"),
      { timeout: 2000 }
    );
  });

  it("ignores irrelevant events", async () => {
    start();
    await vi.waitFor(() => expect(latest).toEqual([]));
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    const before = fake.requests.length;
    fake.emit({ type: "model.updated", data: {} });
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.requests.length).toBe(before);
  });

  it("reconnects the event stream after it drops", async () => {
    start();
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    fake.dropStreams();
    expect(fake.sseClientCount()).toBe(0);
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1), {
      timeout: 2000,
    });
  });

  it("polls as a safety net and reports unhealthy after 3 failures", async () => {
    start({ pollMs: 30 });
    await vi.waitFor(() => expect(health).toContain(true));
    fake.state.fail = true;
    await vi.waitFor(() => expect(health.at(-1)).toBe(false), {
      timeout: 2000,
    });
    fake.state.fail = false;
    await vi.waitFor(() => expect(health.at(-1)).toBe(true), { timeout: 2000 });
  });

  it("stops polling and streaming after stop()", async () => {
    start({ pollMs: 20 });
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(1));
    monitor!.stop();
    await vi.waitFor(() => expect(fake.sseClientCount()).toBe(0));
    const count = fake.requests.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.requests.length).toBe(count);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/monitor.test.ts` Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/monitor.ts`:

```ts
import type { SessionSummary } from "../shared/types";
import type { OpencodeClient } from "./opencode/client";
import { deriveSessions } from "./status";

export interface MonitorOptions {
  client: OpencodeClient;
  projectId: string;
  directory: string;
  onSessions: (sessions: SessionSummary[]) => void;
  onHealth: (healthy: boolean) => void;
  pollMs?: number;
  debounceMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const RELEVANT_EVENT = /^(session|permission|form)\./;
const FAILURES_BEFORE_UNHEALTHY = 3;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

export class Monitor {
  private readonly abort = new AbortController();
  private pollTimer?: ReturnType<typeof setInterval>;
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private failures = 0;
  private stopped = false;
  private inFlight?: Promise<void>;
  private rerun = false;

  constructor(private readonly opts: MonitorOptions) {}

  start(): void {
    void this.reconcile();
    this.pollTimer = setInterval(
      () => void this.reconcile(),
      this.opts.pollMs ?? 5000
    );
    void this.streamLoop();
  }

  stop(): void {
    this.stopped = true;
    this.abort.abort();
    clearInterval(this.pollTimer);
    clearTimeout(this.debounceTimer);
  }

  reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    this.inFlight = this.fetchAndDerive().finally(() => {
      this.inFlight = undefined;
      if (this.rerun && !this.stopped) {
        this.rerun = false;
        void this.reconcile();
      }
    });
    return this.inFlight;
  }

  private async fetchAndDerive(): Promise<void> {
    const { client, directory, projectId } = this.opts;
    try {
      const [sessions, active, permissions, forms] = await Promise.all([
        client.sessions(),
        client.active(),
        client.permissionRequests(directory),
        client.forms(directory),
      ]);
      if (this.stopped) return;
      this.failures = 0;
      this.opts.onHealth(true);
      this.opts.onSessions(
        deriveSessions(projectId, { sessions, active, permissions, forms })
      );
    } catch {
      if (this.stopped) return;
      this.failures += 1;
      if (this.failures >= FAILURES_BEFORE_UNHEALTHY) this.opts.onHealth(false);
    }
  }

  private schedule(): void {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(
      () => void this.reconcile(),
      this.opts.debounceMs ?? 250
    );
  }

  private async streamLoop(): Promise<void> {
    const min = this.opts.minBackoffMs ?? 1000;
    const max = this.opts.maxBackoffMs ?? 30_000;
    let backoff = min;
    while (!this.stopped) {
      try {
        await this.opts.client.subscribe((event) => {
          backoff = min;
          if (RELEVANT_EVENT.test(event.type)) this.schedule();
        }, this.abort.signal);
      } catch {
        // connection failed or dropped; retry below
      }
      if (this.stopped) return;
      await sleep(backoff, this.abort.signal);
      backoff = Math.min(backoff * 2, max);
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/monitor.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/monitor.ts test/server/monitor.test.ts
git commit -m "feat: per-project monitor with SSE + polling"
```

---

### Task 9: opencode runtime (version check, launch, health)

**Files:**

- Create: `src/server/opencode/runtime.ts`
- Test: `test/server/opencode-runtime.test.ts`

**Interfaces:**

- Consumes: `Containers`, `CommandError`, `tailLines` (Task 4); `OpencodeClient`, `OpencodeEndpoint` (Task 5).
- Produces:
  - `OPENCODE_PORT = 4096`
  - `parseOpencodeVersion(output: string): string | undefined`
  - `interface RuntimeDeps { containers: Pick<Containers, "exec">; clientFor: (ep: OpencodeEndpoint) => OpencodeClient; port?: number; healthTimeoutMs?: number; healthIntervalMs?: number; generatePassword?: () => string }`
  - `class OpencodeRuntime { constructor(deps); endpoint(ip: string, password: string): OpencodeEndpoint; isHealthy(ep): Promise<boolean>; ensureRunning(project, { ip, password?, workspaceFolder, onLine }): Promise<{ password: string; version: string }>; stopServer(project): Promise<void> }`

Behaviour: if a password is given and the server already answers `/api/info` with it, return without exec (idempotent start). Otherwise: check `opencode --version` (missing → error; major < 2 → error), kill any stale server (`pkill -f 'opencode [s]erve'` — the bracket keeps pkill from matching its own `sh -c`), launch detached with `nohup`, poll health.

- [ ] **Step 1: Write the failing tests**

`test/server/opencode-runtime.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Containers } from "../../src/server/containers";
import { OpencodeClient } from "../../src/server/opencode/client";
import {
  OpencodeRuntime,
  parseOpencodeVersion,
} from "../../src/server/opencode/runtime";
import type { Project } from "../../src/shared/types";
import { type FakeOpencode, startFakeOpencode } from "../helpers/fake-opencode";
import { type Call, fakeRunner } from "../helpers/fake-runner";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/src/demo/.devcontainer.json",
};
let fake: FakeOpencode;
beforeEach(async () => {
  fake = await startFakeOpencode("pw");
});
afterEach(() => fake.close());

function runtimeWith(versionOutput: { exitCode?: number; stdout?: string }) {
  const { run, calls } = fakeRunner((c: Call) =>
    c.args.includes("--version") ? versionOutput : {}
  );
  const runtime = new OpencodeRuntime({
    containers: new Containers(run),
    clientFor: (ep) => new OpencodeClient(ep),
    port: fake.port,
    healthTimeoutMs: 300,
    healthIntervalMs: 20,
    generatePassword: () => "pw",
  });
  return { runtime, calls };
}
const args = {
  ip: "127.0.0.1",
  workspaceFolder: "/workspaces/demo",
  onLine: () => {},
};

describe("parseOpencodeVersion", () => {
  it.each([
    ["opencode v2.0.20", "2.0.20"],
    ["1.18.31\n", "1.18.31"],
    ["garbage", undefined],
  ])("%s -> %s", (input, expected) =>
    expect(parseOpencodeVersion(input)).toBe(expected)
  );
});

describe("OpencodeRuntime.ensureRunning", () => {
  it("launches opencode serve with the generated password and waits for health", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20\n" });
    const res = await runtime.ensureRunning(project, args);
    expect(res).toEqual({ password: "pw", version: "2.0.20" });
    const launch = calls.find((c) =>
      c.args.at(-1)?.includes("opencode serve --hostname 0.0.0.0")
    );
    expect(launch?.args).toEqual(
      expect.arrayContaining([
        "--remote-env",
        "OPENCODE_PASSWORD=pw",
        "sh",
        "-c",
      ])
    );
    expect(launch?.args.at(-1)).toContain(`--port ${fake.port}`);
    expect(launch?.args.at(-1)).toContain("cd '/workspaces/demo'");
    expect(
      calls.some((c) => c.args.at(-1)?.includes("pkill -f 'opencode [s]erve'"))
    ).toBe(true);
  });

  it("is idempotent when the server already answers with the given password", async () => {
    const { runtime, calls } = runtimeWith({ stdout: "opencode v2.0.20" });
    const res = await runtime.ensureRunning(project, {
      ...args,
      password: "pw",
    });
    expect(res).toEqual({ password: "pw", version: "2.0.20" });
    expect(calls).toHaveLength(0);
  });

  it("fails clearly when opencode is missing", async () => {
    const { runtime } = runtimeWith({ exitCode: 127, stdout: "" });
    await expect(runtime.ensureRunning(project, args)).rejects.toThrow(
      /not installed/
    );
  });

  it("rejects opencode v1", async () => {
    const { runtime } = runtimeWith({ stdout: "1.18.31" });
    await expect(runtime.ensureRunning(project, args)).rejects.toThrow(
      /requires opencode v2/
    );
  });

  it("times out when the server never becomes healthy", async () => {
    const { run } = fakeRunner((c) =>
      c.args.includes("--version") ? { stdout: "2.0.20" } : {}
    );
    const runtime = new OpencodeRuntime({
      containers: new Containers(run),
      clientFor: (ep) => new OpencodeClient(ep),
      port: fake.port,
      healthTimeoutMs: 200,
      healthIntervalMs: 20,
      generatePassword: () => "wrong-password",
    });
    await expect(runtime.ensureRunning(project, args)).rejects.toThrow(
      /did not become healthy/
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/opencode-runtime.test.ts` Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/opencode/runtime.ts`:

```ts
import { randomBytes } from "node:crypto";

import type { Project } from "../../shared/types";
import { CommandError, type Containers, tailLines } from "../containers";
import type { OpencodeClient, OpencodeEndpoint } from "./client";

export const OPENCODE_PORT = 4096;
const LOG_FILE = "/tmp/opendevhub-opencode.log";
const KILL_SERVER = "pkill -f 'opencode [s]erve' || true";

export function parseOpencodeVersion(output: string): string | undefined {
  return output.match(/(\d+)\.(\d+)\.(\d+)/)?.[0];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface RuntimeDeps {
  containers: Pick<Containers, "exec">;
  clientFor: (ep: OpencodeEndpoint) => OpencodeClient;
  port?: number;
  healthTimeoutMs?: number;
  healthIntervalMs?: number;
  generatePassword?: () => string;
}

export class OpencodeRuntime {
  constructor(private readonly deps: RuntimeDeps) {}

  endpoint(ip: string, password: string): OpencodeEndpoint {
    return {
      baseUrl: `http://${ip}:${this.deps.port ?? OPENCODE_PORT}`,
      password,
    };
  }

  async isHealthy(ep: OpencodeEndpoint): Promise<boolean> {
    try {
      await this.deps.clientFor(ep).info();
      return true;
    } catch {
      return false;
    }
  }

  async ensureRunning(
    project: Project,
    args: {
      ip: string;
      password?: string;
      workspaceFolder: string;
      onLine: (line: string) => void;
    }
  ): Promise<{ password: string; version: string }> {
    if (args.password) {
      try {
        const info = await this.deps
          .clientFor(this.endpoint(args.ip, args.password))
          .info();
        return { password: args.password, version: info.version };
      } catch {
        // not running or different password: relaunch below
      }
    }

    const { containers } = this.deps;
    const versionRun = await containers.exec(project, [
      "opencode",
      "--version",
    ]);
    if (versionRun.exitCode !== 0) {
      throw new CommandError(
        "opencode is not installed in the devcontainer (expected opencode v2 on PATH)",
        tailLines(versionRun.stderr + versionRun.stdout)
      );
    }
    const version = parseOpencodeVersion(versionRun.stdout);
    if (!version || Number(version.split(".")[0]) < 2) {
      throw new CommandError(
        `opencode ${version ?? "(unknown version)"} found, but opendevhub requires opencode v2`
      );
    }
    args.onLine(`opencode ${version} found in container`);

    const password =
      this.deps.generatePassword?.() ?? randomBytes(32).toString("base64url");
    const port = this.deps.port ?? OPENCODE_PORT;
    await containers.exec(project, ["sh", "-c", KILL_SERVER]);
    const script =
      `cd ${shellQuote(args.workspaceFolder)} && ` +
      `nohup opencode serve --hostname 0.0.0.0 --port ${port} < /dev/null > ${LOG_FILE} 2>&1 &`;
    const launch = await containers.exec(project, ["sh", "-c", script], {
      env: { OPENCODE_PASSWORD: password },
    });
    if (launch.exitCode !== 0) {
      throw new CommandError(
        "failed to launch opencode serve",
        tailLines(launch.stderr + launch.stdout)
      );
    }
    args.onLine(`launched opencode serve on port ${port}; waiting for health`);

    const ep = this.endpoint(args.ip, password);
    const deadline = Date.now() + (this.deps.healthTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (await this.isHealthy(ep)) return { password, version };
      await new Promise((r) =>
        setTimeout(r, this.deps.healthIntervalMs ?? 500)
      );
    }
    const log = await containers.exec(project, [
      "sh",
      "-c",
      `tail -n 20 ${LOG_FILE} 2>/dev/null`,
    ]);
    throw new CommandError(
      "opencode did not become healthy within 30 s",
      tailLines(log.stdout)
    );
  }

  async stopServer(project: Project): Promise<void> {
    await this.deps.containers.exec(project, ["sh", "-c", KILL_SERVER]);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/opencode-runtime.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/opencode/runtime.ts test/server/opencode-runtime.test.ts
git commit -m "feat: launch and health-check opencode v2 inside the container"
```

---

### Task 10: Orchestrator and log buffer

**Files:**

- Create: `src/server/log-buffer.ts`, `src/server/orchestrator.ts`
- Test: `test/server/orchestrator.test.ts`

**Interfaces:**

- Consumes: `StateStore` (Task 7), `Containers`/`CommandError`/`ContainerInfo` (Task 4), `OpencodeRuntime` (Task 9), `Monitor`/`MonitorOptions` (Task 8), `OpencodeClient`/`OpencodeEndpoint` (Task 5).
- Produces:
  - `class LogBuffer { constructor(max?: number); push(line: string): void; lines(): string[] }`
  - `class BusyError extends Error`, `class NotFoundError extends Error`
  - `type ContainersPort = Pick<Containers, "up" | "inspect" | "listManaged" | "stop">`
  - `type RuntimePort = Pick<OpencodeRuntime, "ensureRunning" | "stopServer" | "isHealthy" | "endpoint">`
  - `interface MonitorHandle { start(): void; stop(): void }`
  - `interface OrchestratorDeps { store; containers: ContainersPort; runtime: RuntimePort; clientFor; roots: () => string[]; scan: (roots: string[]) => Promise<Project[]>; monitorFactory?: (opts: MonitorOptions) => MonitorHandle }`
  - `class Orchestrator { rescan(): Promise<void>; adopt(): Promise<void>; start(id): Promise<void>; stop(id): Promise<void>; rebuild(id): Promise<void>; restartOpencode(id): Promise<void>; refreshContainers(): Promise<void>; logLines(id): string[]; onLog(fn: (projectId: string, line: string) => void): () => void; shutdown(): void }`
  - `start/stop/rebuild/restartOpencode` throw `NotFoundError`/`BusyError` **synchronously**; otherwise return a promise that never rejects (failures land in `runtime.error`).

- [ ] **Step 1: Write the failing tests**

`test/server/orchestrator.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { PersistedState } from "../../src/server/config";
import { CommandError, type ContainerInfo } from "../../src/server/containers";
import type { MonitorOptions } from "../../src/server/monitor";
import type { OpencodeClient } from "../../src/server/opencode/client";
import {
  BusyError,
  NotFoundError,
  Orchestrator,
} from "../../src/server/orchestrator";
import { StateStore } from "../../src/server/state";
import type { Project } from "../../src/shared/types";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/src/demo/.devcontainer/devcontainer.json",
};
const running: ContainerInfo = {
  id: "c1",
  running: true,
  ip: "172.17.0.9",
  projectId: project.id,
};

function setup(persisted: PersistedState = { projects: {} }) {
  const store = new StateStore({ port: 7777, persisted, persist: () => {} });
  const monitors: Array<{
    opts: MonitorOptions;
    started: boolean;
    stopped: boolean;
  }> = [];
  const containers = {
    up: vi.fn(
      async (
        _p: Project,
        o: { rebuild: boolean; onLine: (l: string) => void }
      ) => {
        o.onLine("building image");
        return { containerId: "c1", remoteWorkspaceFolder: "/workspaces/demo" };
      }
    ),
    inspect: vi.fn(async (): Promise<ContainerInfo | undefined> => running),
    listManaged: vi.fn(async (): Promise<ContainerInfo[]> => []),
    stop: vi.fn(async () => {}),
  };
  const runtime = {
    endpoint: (ip: string, password: string) => ({
      baseUrl: `http://${ip}:4096`,
      password,
    }),
    ensureRunning: vi.fn(async (_p: Project, _a: { password?: string }) => ({
      password: "pw",
      version: "2.0.20",
    })),
    stopServer: vi.fn(async () => {}),
    isHealthy: vi.fn(async () => true),
  };
  const orch = new Orchestrator({
    store,
    containers,
    runtime,
    clientFor: () => ({}) as OpencodeClient,
    roots: () => ["/src"],
    scan: async () => [project],
    monitorFactory: (opts) => {
      const m = {
        opts,
        started: false,
        stopped: false,
        start() {
          m.started = true;
        },
        stop() {
          m.stopped = true;
        },
      };
      monitors.push(m);
      return m;
    },
  });
  return { store, containers, runtime, orch, monitors };
}

describe("Orchestrator", () => {
  it("start brings up the container, launches opencode and starts a monitor", async () => {
    const { store, containers, runtime, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    expect(containers.up.mock.calls[0][1].rebuild).toBe(false);
    expect(runtime.ensureRunning.mock.calls[0][1]).toMatchObject({
      ip: "172.17.0.9",
      workspaceFolder: "/workspaces/demo",
    });
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
      containerId: "c1",
      password: "pw",
      opencodeVersion: "2.0.20",
      error: undefined,
    });
    expect(monitors[0]).toMatchObject({ started: true });
    expect(monitors[0].opts.directory).toBe("/workspaces/demo");
    expect(orch.logLines(project.id)).toContain("building image");
  });

  it("throws synchronously for unknown projects and concurrent actions", async () => {
    const { orch } = setup();
    await orch.rescan();
    expect(() => orch.start("nope")).toThrow(NotFoundError);
    const first = orch.start(project.id);
    expect(() => orch.stop(project.id)).toThrow(BusyError);
    await first;
    await expect(orch.stop(project.id)).resolves.toBeUndefined();
  });

  it("records devcontainer failures as error state with log tail", async () => {
    const { store, containers, orch } = setup();
    containers.up.mockRejectedValueOnce(
      new CommandError("devcontainer up failed: boom", ["tail line"])
    );
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "error",
      error: "devcontainer up failed: boom",
    });
    expect(orch.logLines(project.id)).toContain("tail line");
  });

  it("rejects containers without a bridge IP", async () => {
    const { store, containers, orch } = setup();
    containers.inspect.mockResolvedValueOnce({
      id: "c1",
      running: true,
      projectId: project.id,
    });
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id).error).toMatch(/host networking/);
  });

  it("keeps the container running but marks opencode unhealthy when launch fails", async () => {
    const { store, runtime, orch } = setup();
    runtime.ensureRunning.mockRejectedValueOnce(
      new CommandError(
        "opencode 1.18.31 found, but opendevhub requires opencode v2"
      )
    );
    await orch.rescan();
    await orch.start(project.id);
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "unhealthy",
    });
    expect(store.runtime(project.id).error).toMatch(/requires opencode v2/);
  });

  it("rebuild forces a new container and a new password", async () => {
    const { containers, runtime, orch } = setup({
      projects: { [project.id]: { password: "old" } },
    });
    await orch.rescan();
    await orch.rebuild(project.id);
    expect(containers.up.mock.calls[0][1].rebuild).toBe(true);
    expect(runtime.ensureRunning.mock.calls[0][1].password).toBeUndefined();
  });

  it("start reuses a persisted password", async () => {
    const { runtime, orch } = setup({
      projects: { [project.id]: { password: "old" } },
    });
    await orch.rescan();
    await orch.start(project.id);
    expect(runtime.ensureRunning.mock.calls[0][1].password).toBe("old");
  });

  it("stop stops monitor, opencode and container and clears sessions", async () => {
    const { store, containers, runtime, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    store.setSessions(project.id, [
      {
        id: "s",
        projectId: project.id,
        title: "t",
        directory: "/w",
        updatedAt: 1,
        status: "idle",
      },
    ]);
    await orch.stop(project.id);
    expect(monitors[0].stopped).toBe(true);
    expect(runtime.stopServer).toHaveBeenCalled();
    expect(containers.stop).toHaveBeenCalledWith("c1");
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "stopped",
      opencode: "absent",
    });
    expect(store.snapshot().projects[0].sessions).toEqual([]);
  });

  it("restartOpencode relaunches with a fresh password", async () => {
    const { runtime, orch } = setup();
    await orch.rescan();
    await orch.start(project.id);
    await orch.restartOpencode(project.id);
    expect(runtime.ensureRunning).toHaveBeenCalledTimes(2);
    expect(runtime.ensureRunning.mock.calls[1][1].password).toBeUndefined();
  });

  it("adopts running containers with a working persisted password", async () => {
    const { store, containers, orch, monitors } = setup({
      projects: {
        [project.id]: { password: "pw", workspaceFolder: "/workspaces/demo" },
      },
    });
    containers.listManaged.mockResolvedValueOnce([running]);
    await orch.rescan();
    await orch.adopt();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "healthy",
      containerId: "c1",
    });
    expect(monitors).toHaveLength(1);
  });

  it("adopts a running container whose opencode is gone as unhealthy", async () => {
    const { store, containers, runtime, orch, monitors } = setup({
      projects: { [project.id]: { password: "pw" } },
    });
    containers.listManaged.mockResolvedValueOnce([running]);
    runtime.isHealthy.mockResolvedValueOnce(false);
    await orch.rescan();
    await orch.adopt();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "running",
      opencode: "unhealthy",
    });
    expect(store.runtime(project.id).error).toMatch(/Restart opencode/);
    expect(monitors).toHaveLength(0);
  });

  it("adopts stopped containers as stopped and ignores unknown labels", async () => {
    const { store, containers, orch } = setup();
    containers.listManaged.mockResolvedValueOnce([
      { ...running, running: false },
      { id: "x", running: true, ip: "1.2.3.4", projectId: "other-000000" },
    ]);
    await orch.rescan();
    await orch.adopt();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "stopped",
      containerId: "c1",
    });
  });

  it("refreshContainers notices containers stopped outside opendevhub", async () => {
    const { store, containers, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    containers.inspect.mockResolvedValueOnce({ ...running, running: false });
    await orch.refreshContainers();
    expect(store.runtime(project.id)).toMatchObject({
      containerState: "stopped",
      opencode: "absent",
    });
    expect(monitors[0].stopped).toBe(true);
  });

  it("monitor health updates opencode state; sessions flow into the store", async () => {
    const { store, orch, monitors } = setup();
    await orch.rescan();
    await orch.start(project.id);
    monitors[0].opts.onHealth(false);
    expect(store.runtime(project.id).opencode).toBe("unhealthy");
    monitors[0].opts.onSessions([
      {
        id: "s",
        projectId: project.id,
        title: "t",
        directory: "/w",
        updatedAt: 1,
        status: "running",
      },
    ]);
    expect(store.snapshot().projects[0].sessions).toHaveLength(1);
  });

  it("notifies log listeners and caps the log buffer at 500 lines", async () => {
    const { containers, orch } = setup();
    containers.up.mockImplementationOnce(async (_p, o) => {
      for (let i = 0; i < 600; i++) o.onLine(`line ${i}`);
      return { containerId: "c1", remoteWorkspaceFolder: "/workspaces/demo" };
    });
    const seen: string[] = [];
    orch.onLog((_id, line) => seen.push(line));
    await orch.rescan();
    await orch.start(project.id);
    expect(seen).toContain("line 599");
    expect(orch.logLines(project.id)).toHaveLength(500);
    expect(orch.logLines(project.id)[0]).not.toBe("line 0");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/orchestrator.test.ts` Expected: FAIL — module not found.

- [ ] **Step 3: Implement the log buffer**

`src/server/log-buffer.ts`:

```ts
export class LogBuffer {
  private buffer: string[] = [];

  constructor(private readonly max = 500) {}

  push(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length > this.max)
      this.buffer.splice(0, this.buffer.length - this.max);
  }

  lines(): string[] {
    return [...this.buffer];
  }
}
```

- [ ] **Step 4: Implement the orchestrator**

`src/server/orchestrator.ts`:

```ts
import path from "node:path";

import type { Project, ProjectId } from "../shared/types";
import {
  CommandError,
  type ContainerInfo,
  type Containers,
} from "./containers";
import { LogBuffer } from "./log-buffer";
import { Monitor, type MonitorOptions } from "./monitor";
import type { OpencodeClient, OpencodeEndpoint } from "./opencode/client";
import type { OpencodeRuntime } from "./opencode/runtime";
import type { StateStore } from "./state";

export class BusyError extends Error {
  constructor(id: string) {
    super(`another action is already running for ${id}`);
    this.name = "BusyError";
  }
}

export class NotFoundError extends Error {
  constructor(id: string) {
    super(`unknown project ${id}`);
    this.name = "NotFoundError";
  }
}

export type ContainersPort = Pick<
  Containers,
  "up" | "inspect" | "listManaged" | "stop"
>;
export type RuntimePort = Pick<
  OpencodeRuntime,
  "ensureRunning" | "stopServer" | "isHealthy" | "endpoint"
>;
export interface MonitorHandle {
  start(): void;
  stop(): void;
}

export interface OrchestratorDeps {
  store: StateStore;
  containers: ContainersPort;
  runtime: RuntimePort;
  clientFor: (ep: OpencodeEndpoint) => OpencodeClient;
  roots: () => string[];
  scan: (roots: string[]) => Promise<Project[]>;
  monitorFactory?: (opts: MonitorOptions) => MonitorHandle;
}

export class Orchestrator {
  private readonly busy = new Set<ProjectId>();
  private readonly monitors = new Map<ProjectId, MonitorHandle>();
  private readonly logs = new Map<ProjectId, LogBuffer>();
  private readonly logListeners = new Set<
    (projectId: ProjectId, line: string) => void
  >();

  constructor(private readonly deps: OrchestratorDeps) {}

  async rescan(): Promise<void> {
    this.deps.store.setProjects(await this.deps.scan(this.deps.roots()));
  }

  logLines(id: ProjectId): string[] {
    return this.logs.get(id)?.lines() ?? [];
  }

  onLog(fn: (projectId: ProjectId, line: string) => void): () => void {
    this.logListeners.add(fn);
    return () => this.logListeners.delete(fn);
  }

  start(id: ProjectId): Promise<void> {
    return this.exclusive(id, (p) => this.bringUp(p, false));
  }

  rebuild(id: ProjectId): Promise<void> {
    return this.exclusive(id, (p) => {
      this.stopMonitor(p.id);
      return this.bringUp(p, true);
    });
  }

  restartOpencode(id: ProjectId): Promise<void> {
    return this.exclusive(id, async (p) => {
      const rt = this.deps.store.runtime(p.id);
      if (rt.containerState !== "running" || !rt.containerIp) {
        this.fail(
          p.id,
          new Error("container is not running — start the project first")
        );
        return;
      }
      this.stopMonitor(p.id);
      this.deps.store.updateRuntime(p.id, {
        opencode: "starting",
        error: undefined,
      });
      try {
        await this.launchOpencode(p, undefined);
      } catch (err) {
        this.fail(p.id, err);
      }
    });
  }

  stop(id: ProjectId): Promise<void> {
    return this.exclusive(id, async (p) => {
      const { store, runtime, containers } = this.deps;
      this.stopMonitor(p.id);
      const rt = store.runtime(p.id);
      store.updateRuntime(p.id, {
        containerState: "stopping",
        error: undefined,
      });
      try {
        if (rt.containerState === "running")
          await runtime.stopServer(p).catch(() => {});
        if (rt.containerId) await containers.stop(rt.containerId);
        store.updateRuntime(p.id, {
          containerState: "stopped",
          opencode: "absent",
          containerIp: undefined,
        });
        store.setSessions(p.id, []);
      } catch (err) {
        this.fail(p.id, err);
      }
    });
  }

  async adopt(): Promise<void> {
    const { store, containers, runtime } = this.deps;
    let managed: ContainerInfo[];
    try {
      managed = await containers.listManaged();
    } catch {
      return;
    }
    for (const info of managed) {
      const id = info.projectId;
      if (!id || !store.project(id)) continue;
      if (!info.running) {
        store.updateRuntime(id, {
          containerId: info.id,
          containerState: "stopped",
          opencode: "absent",
        });
        continue;
      }
      store.updateRuntime(id, {
        containerId: info.id,
        containerIp: info.ip,
        containerState: "running",
      });
      const rt = store.runtime(id);
      if (
        info.ip &&
        rt.password &&
        (await runtime.isHealthy(runtime.endpoint(info.ip, rt.password)))
      ) {
        store.updateRuntime(id, { opencode: "healthy", error: undefined });
        this.startMonitor(id);
      } else {
        store.updateRuntime(id, {
          opencode: "unhealthy",
          error: "opencode is not running — use Restart opencode",
        });
      }
    }
  }

  async refreshContainers(): Promise<void> {
    const { store, containers } = this.deps;
    for (const p of store.projects()) {
      const rt = store.runtime(p.id);
      if (
        this.busy.has(p.id) ||
        rt.containerState !== "running" ||
        !rt.containerId
      )
        continue;
      const info = await containers.inspect(rt.containerId);
      if (info?.running) continue;
      this.stopMonitor(p.id);
      store.updateRuntime(p.id, {
        containerState: "stopped",
        opencode: "absent",
        containerIp: undefined,
      });
      store.setSessions(p.id, []);
    }
  }

  shutdown(): void {
    for (const id of [...this.monitors.keys()]) this.stopMonitor(id);
  }

  private exclusive(
    id: ProjectId,
    fn: (project: Project) => Promise<void>
  ): Promise<void> {
    const project = this.deps.store.project(id);
    if (!project) throw new NotFoundError(id);
    if (this.busy.has(id)) throw new BusyError(id);
    this.busy.add(id);
    return fn(project).finally(() => this.busy.delete(id));
  }

  private async bringUp(project: Project, rebuild: boolean): Promise<void> {
    const { store, containers } = this.deps;
    store.updateRuntime(project.id, {
      containerState: "starting",
      opencode: "absent",
      error: undefined,
    });
    try {
      const up = await containers.up(project, {
        rebuild,
        onLine: (l) => this.log(project.id, l),
      });
      const info = await containers.inspect(up.containerId);
      if (!info?.running)
        throw new CommandError(
          "container is not running after devcontainer up"
        );
      if (!info.ip) {
        throw new CommandError(
          "container has no bridge network IP (host networking is not supported)"
        );
      }
      store.updateRuntime(project.id, {
        containerId: up.containerId,
        containerIp: info.ip,
        workspaceFolder: up.remoteWorkspaceFolder,
        containerState: "running",
        opencode: "starting",
      });
      await this.launchOpencode(
        project,
        rebuild ? undefined : store.runtime(project.id).password
      );
    } catch (err) {
      this.fail(project.id, err);
    }
  }

  private async launchOpencode(
    project: Project,
    password: string | undefined
  ): Promise<void> {
    const { store, runtime } = this.deps;
    const rt = store.runtime(project.id);
    const result = await runtime.ensureRunning(project, {
      ip: rt.containerIp!,
      password,
      workspaceFolder: this.workspaceFolder(project),
      onLine: (l) => this.log(project.id, l),
    });
    store.updateRuntime(project.id, {
      password: result.password,
      opencodeVersion: result.version,
      opencode: "healthy",
      error: undefined,
    });
    this.startMonitor(project.id);
  }

  private workspaceFolder(project: Project): string {
    return (
      this.deps.store.runtime(project.id).workspaceFolder ??
      `/workspaces/${path.basename(project.path)}`
    );
  }

  private startMonitor(id: ProjectId): void {
    this.stopMonitor(id);
    const { store, runtime, clientFor } = this.deps;
    const project = store.project(id)!;
    const rt = store.runtime(id);
    const factory =
      this.deps.monitorFactory ?? ((opts: MonitorOptions) => new Monitor(opts));
    const monitor = factory({
      client: clientFor(runtime.endpoint(rt.containerIp!, rt.password!)),
      projectId: id,
      directory: this.workspaceFolder(project),
      onSessions: (sessions) => store.setSessions(id, sessions),
      onHealth: (healthy) => {
        if (store.runtime(id).opencode === "starting") return;
        store.updateRuntime(id, {
          opencode: healthy ? "healthy" : "unhealthy",
        });
      },
    });
    this.monitors.set(id, monitor);
    monitor.start();
  }

  private stopMonitor(id: ProjectId): void {
    this.monitors.get(id)?.stop();
    this.monitors.delete(id);
  }

  private log(id: ProjectId, line: string): void {
    let buffer = this.logs.get(id);
    if (!buffer) {
      buffer = new LogBuffer();
      this.logs.set(id, buffer);
    }
    buffer.push(line);
    for (const fn of this.logListeners) fn(id, line);
  }

  private fail(id: ProjectId, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CommandError)
      for (const line of err.tail) this.log(id, line);
    this.log(id, `error: ${message}`);
    const containerUp =
      this.deps.store.runtime(id).containerState === "running";
    this.deps.store.updateRuntime(id, {
      containerState: containerUp ? "running" : "error",
      opencode: containerUp ? "unhealthy" : "absent",
      error: message,
    });
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run test/server/orchestrator.test.ts && npx tsc --noEmit` Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/server/log-buffer.ts src/server/orchestrator.ts test/server/orchestrator.test.ts
git commit -m "feat: orchestrator for project lifecycle, adoption and monitoring"
```

---

### Task 11: Host routing and reverse proxy

**Files:**

- Create: `src/server/hosts.ts`, `src/server/proxy.ts`
- Test: `test/server/hosts.test.ts`, `test/server/proxy.test.ts`

**Interfaces:**

- Consumes: `basicAuth` (Task 5).
- Produces:
  - `type HostRoute = { kind: "dashboard" } | { kind: "project"; projectId: string } | { kind: "reject" }`
  - `classifyHost(host: string | undefined, port: number): HostRoute`
  - `interface ProxyTarget { host: string; port: number; password: string }`
  - `type ResolveTarget = (projectId: string) => ProxyTarget | undefined`
  - `proxyRequest(req: IncomingMessage, res: ServerResponse, projectId: string, resolve: ResolveTarget, dashboardUrl: string): void`
  - `proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, projectId: string, resolve: ResolveTarget): void`

- [ ] **Step 1: Write the failing host tests**

`test/server/hosts.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { classifyHost } from "../../src/server/hosts";

describe("classifyHost", () => {
  it.each([
    ["localhost:7777", { kind: "dashboard" }],
    ["127.0.0.1:7777", { kind: "dashboard" }],
    ["LOCALHOST:7777", { kind: "dashboard" }],
    [
      "demo-abc123.localhost:7777",
      { kind: "project", projectId: "demo-abc123" },
    ],
    [
      "Demo-ABC123.Localhost:7777",
      { kind: "project", projectId: "demo-abc123" },
    ],
    ["localhost:8888", { kind: "reject" }],
    ["localhost", { kind: "reject" }],
    ["evil.com:7777", { kind: "reject" }],
    ["a.b.localhost:7777", { kind: "reject" }],
    ["-bad.localhost:7777", { kind: "reject" }],
    ["[::1]:7777", { kind: "reject" }],
    [undefined, { kind: "reject" }],
  ])("%s", (host, expected) => {
    expect(classifyHost(host, 7777)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Implement `classifyHost` and run**

`src/server/hosts.ts`:

```ts
export type HostRoute =
  | { kind: "dashboard" }
  | { kind: "project"; projectId: string }
  | { kind: "reject" };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function classifyHost(
  host: string | undefined,
  port: number
): HostRoute {
  if (!host) return { kind: "reject" };
  const h = host.toLowerCase();
  if (h === `localhost:${port}` || h === `127.0.0.1:${port}`)
    return { kind: "dashboard" };
  const suffix = `.localhost:${port}`;
  if (h.endsWith(suffix)) {
    const label = h.slice(0, -suffix.length);
    if (LABEL.test(label)) return { kind: "project", projectId: label };
  }
  return { kind: "reject" };
}
```

Run: `npx vitest run test/server/hosts.test.ts` Expected: PASS.

- [ ] **Step 3: Write the failing proxy tests**

`test/server/proxy.test.ts`:

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import { basicAuth } from "../../src/server/opencode/client";
import {
  type ProxyTarget,
  proxyRequest,
  proxyUpgrade,
} from "../../src/server/proxy";

let upstream: http.Server;
let proxy: http.Server;
let target: ProxyTarget | undefined;
let proxyUrl: string;
let sseRes: http.ServerResponse | undefined;

const listen = (s: http.Server) =>
  new Promise<number>((resolve) =>
    s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port))
  );

beforeEach(async () => {
  upstream = http.createServer((req, res) => {
    if (req.url === "/echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          host: req.headers.host,
          authorization: req.headers.authorization,
          origin: req.headers.origin,
        })
      );
    } else if (req.url === "/challenge") {
      res.writeHead(401, { "www-authenticate": 'Basic realm="Secure Area"' });
      res.end("nope");
    } else if (req.url === "/sse") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      sseRes = res;
    } else if (req.url === "/upload") {
      let n = 0;
      req.on("data", (c: Buffer) => (n += c.length));
      req.on("end", () => res.end(String(n)));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws, req) => {
    ws.send(`auth:${req.headers.authorization}`);
    ws.on("message", (m) => ws.send(`echo:${m.toString()}`));
  });
  const upstreamPort = await listen(upstream);
  target = { host: "127.0.0.1", port: upstreamPort, password: "pw" };
  const resolve = () => target;
  proxy = http.createServer((req, res) =>
    proxyRequest(req, res, "demo", resolve, "http://localhost:7777/")
  );
  proxy.on("upgrade", (req, socket, head) =>
    proxyUpgrade(req, socket, head, "demo", resolve)
  );
  proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
});

afterEach(async () => {
  sseRes?.end();
  sseRes = undefined;
  for (const s of [proxy, upstream]) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
});

describe("proxyRequest", () => {
  it("injects basic auth and rewrites host and origin", async () => {
    const res = await fetch(`${proxyUrl}/echo`, {
      headers: {
        authorization: "Bearer user-token",
        origin: "http://demo.localhost:7777",
      },
    });
    const body = await res.json();
    expect(body).toEqual({
      host: `127.0.0.1:${target!.port}`,
      authorization: basicAuth("pw"),
      origin: `http://127.0.0.1:${target!.port}`,
    });
  });

  it("strips www-authenticate so browsers never show a login dialog", async () => {
    const res = await fetch(`${proxyUrl}/challenge`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("streams SSE without waiting for the upstream to finish", async () => {
    const res = await fetch(`${proxyUrl}/sse`);
    const reader = res.body!.getReader();
    const { value } = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SSE was buffered")), 1000)
      ),
    ]);
    expect(new TextDecoder().decode(value)).toContain("data: first");
    await reader.cancel();
  });

  it("streams request bodies", async () => {
    const res = await fetch(`${proxyUrl}/upload`, {
      method: "POST",
      body: "x".repeat(100_000),
    });
    expect(await res.text()).toBe("100000");
  });

  it("returns a 503 page when the project is not running", async () => {
    target = undefined;
    const res = await fetch(`${proxyUrl}/`);
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("http://localhost:7777/");
  });

  it("returns a 502 page when the upstream is unreachable", async () => {
    target = { host: "127.0.0.1", port: 1, password: "pw" };
    const res = await fetch(`${proxyUrl}/`);
    expect(res.status).toBe(502);
  });
});

describe("proxyUpgrade", () => {
  it("tunnels websockets with injected auth", async () => {
    const ws = new WebSocket(`${proxyUrl.replace("http", "ws")}/pty`);
    const messages: string[] = [];
    ws.on("message", (m) => messages.push(m.toString()));
    await new Promise((r) => ws.once("open", r));
    ws.send("hi");
    await expect
      .poll(() => messages)
      .toEqual([`auth:${basicAuth("pw")}`, "echo:hi"]);
    ws.close();
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx vitest run test/server/proxy.test.ts` Expected: FAIL — module not found.

- [ ] **Step 5: Implement the proxy**

`src/server/proxy.ts`:

```ts
import http, {
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";

import { basicAuth } from "./opencode/client";

export interface ProxyTarget {
  host: string;
  port: number;
  password: string;
}

export type ResolveTarget = (projectId: string) => ProxyTarget | undefined;

const DROPPED_RESPONSE_HEADERS = new Set([
  "www-authenticate",
  "connection",
  "keep-alive",
]);

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sendPage(
  res: ServerResponse,
  status: number,
  title: string,
  message: string,
  dashboardUrl: string
): void {
  const html =
    `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
    `<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">` +
    `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>` +
    `<p><a href="${escapeHtml(dashboardUrl)}">Back to the opendevhub dashboard</a></p></body>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function upstreamHeaders(
  req: IncomingMessage,
  target: ProxyTarget
): OutgoingHttpHeaders {
  const origin = `http://${target.host}:${target.port}`;
  const headers: OutgoingHttpHeaders = { ...req.headers };
  headers.host = `${target.host}:${target.port}`;
  headers.authorization = basicAuth(target.password);
  if (headers.origin) headers.origin = origin;
  return headers;
}

export function proxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  projectId: string,
  resolve: ResolveTarget,
  dashboardUrl: string
): void {
  const target = resolve(projectId);
  if (!target) {
    sendPage(
      res,
      503,
      "Project not running",
      "Start it from the dashboard, then reload this page.",
      dashboardUrl
    );
    return;
  }
  const upstream = http.request(
    {
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, target),
    },
    (upRes) => {
      const headers: OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (v !== undefined && !DROPPED_RESPONSE_HEADERS.has(k)) headers[k] = v;
      }
      res.writeHead(upRes.statusCode ?? 502, headers);
      res.flushHeaders();
      upRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (!res.headersSent)
      sendPage(res, 502, "opencode unreachable", err.message, dashboardUrl);
    else res.destroy();
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

export function proxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  projectId: string,
  resolve: ResolveTarget
): void {
  const target = resolve(projectId);
  if (!target) {
    socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    return;
  }
  const upstream = http.request({
    host: target.host,
    port: target.port,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, target),
  });
  upstream.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = ["HTTP/1.1 101 Switching Protocols"];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2)
      lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    socket.write(lines.join("\r\n") + "\r\n\r\n");
    if (upHead.length) socket.write(upHead);
    if (head.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on("error", () => socket.destroy());
    socket.on("error", () => upSocket.destroy());
    socket.on("close", () => upSocket.destroy());
  });
  upstream.on("response", (upRes) => {
    socket.end(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n\r\n`);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/server/hosts.test.ts test/server/proxy.test.ts` Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/hosts.ts src/server/proxy.ts test/server/hosts.test.ts test/server/proxy.test.ts
git commit -m "feat: host routing and authenticated reverse proxy (HTTP, SSE, WS)"
```

---

### Task 12: Dashboard API

**Files:**

- Create: `src/server/dashboard-api.ts`
- Test: `test/server/dashboard-api.test.ts`

**Interfaces:**

- Consumes: `StateStore` (Task 7); `Orchestrator`, `BusyError`, `NotFoundError` (Task 10).
- Produces:
  - `type DashboardOrchestrator = Pick<Orchestrator, "start" | "stop" | "rebuild" | "restartOpencode" | "rescan" | "logLines" | "onLog">`
  - `createDashboardApp(deps: { store: StateStore; orchestrator: DashboardOrchestrator; webDir?: string }): Hono`
  - Routes: see spec §5.6. Action responses: `202 {accepted:true}`, `404`, `409`, `412` (preflight errors). SSE events: `snapshot` (full `DashboardSnapshot`, coalesced 50 ms), `log` (`LogEvent`), `ping` every 15 s.

- [ ] **Step 1: Write the failing tests**

`test/server/dashboard-api.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createDashboardApp,
  type DashboardOrchestrator,
} from "../../src/server/dashboard-api";
import { BusyError, NotFoundError } from "../../src/server/orchestrator";
import { StateStore } from "../../src/server/state";
import type { Project } from "../../src/shared/types";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/x",
};

function setup(webDir?: string) {
  const store = new StateStore({
    port: 7777,
    persisted: { projects: {} },
    persist: () => {},
  });
  store.setProjects([project]);
  store.updateRuntime(project.id, { password: "secret" });
  const orchestrator = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    rebuild: vi.fn(() => Promise.resolve()),
    restartOpencode: vi.fn(() => Promise.resolve()),
    rescan: vi.fn(async () => {}),
    logLines: vi.fn(() => ["a", "b"]),
    onLog: vi.fn(() => () => {}),
  } satisfies DashboardOrchestrator;
  return {
    store,
    orchestrator,
    app: createDashboardApp({ store, orchestrator, webDir }),
  };
}

describe("dashboard API", () => {
  it("GET /api/projects returns the snapshot without passwords", async () => {
    const { app } = setup();
    const res = await app.request("/api/projects");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("secret");
    expect(JSON.parse(text).projects[0].project.id).toBe(project.id);
  });

  it.each([
    ["start", "start"],
    ["stop", "stop"],
    ["rebuild", "rebuild"],
    ["restart-opencode", "restartOpencode"],
  ] as const)("POST %s triggers orchestrator.%s", async (route, method) => {
    const { app, orchestrator } = setup();
    const res = await app.request(`/api/projects/${project.id}/${route}`, {
      method: "POST",
    });
    expect(res.status).toBe(202);
    expect(orchestrator[method]).toHaveBeenCalledWith(project.id);
  });

  it("maps BusyError to 409 and NotFoundError to 404", async () => {
    const { app, orchestrator } = setup();
    orchestrator.start.mockImplementationOnce(() => {
      throw new BusyError(project.id);
    });
    expect(
      (
        await app.request(`/api/projects/${project.id}/start`, {
          method: "POST",
        })
      ).status
    ).toBe(409);
    orchestrator.start.mockImplementationOnce(() => {
      throw new NotFoundError("x");
    });
    expect(
      (await app.request(`/api/projects/x/start`, { method: "POST" })).status
    ).toBe(404);
  });

  it("refuses actions while preflight has errors", async () => {
    const { app, store, orchestrator } = setup();
    store.setPreflight({ errors: ["Docker daemon is not reachable"] });
    const res = await app.request(`/api/projects/${project.id}/start`, {
      method: "POST",
    });
    expect(res.status).toBe(412);
    expect(orchestrator.start).not.toHaveBeenCalled();
  });

  it("rescan re-runs discovery and returns the snapshot", async () => {
    const { app, orchestrator } = setup();
    const res = await app.request("/api/projects/rescan", { method: "POST" });
    expect(res.status).toBe(200);
    expect(orchestrator.rescan).toHaveBeenCalled();
  });

  it("GET logs returns buffered lines", async () => {
    const { app } = setup();
    expect(
      await (await app.request(`/api/projects/${project.id}/logs`)).json()
    ).toEqual({ lines: ["a", "b"] });
  });

  it("GET /api/events starts with a snapshot event", async () => {
    const { app } = setup();
    const res = await app.request("/api/events");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: snapshot");
    expect(text).not.toContain("secret");
    await reader.cancel();
  });

  it("serves the SPA with index.html fallback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-web-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html>app</html>");
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
    const { app } = setup(dir);
    expect(await (await app.request("/")).text()).toContain("app");
    expect(await (await app.request("/some/route")).text()).toContain("app");
    const js = await app.request("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("explains how to build the UI when no webDir is available", async () => {
    const { app } = setup(undefined);
    const res = await app.request("/");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("npm run build");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/dashboard-api.test.ts` Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/server/dashboard-api.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import type { LogEvent } from "../shared/types";
import { BusyError, NotFoundError, type Orchestrator } from "./orchestrator";
import type { StateStore } from "./state";

export type DashboardOrchestrator = Pick<
  Orchestrator,
  | "start"
  | "stop"
  | "rebuild"
  | "restartOpencode"
  | "rescan"
  | "logLines"
  | "onLog"
>;

export interface DashboardDeps {
  store: StateStore;
  orchestrator: DashboardOrchestrator;
  webDir?: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

export function createDashboardApp(deps: DashboardDeps): Hono {
  const { store, orchestrator } = deps;
  const app = new Hono();

  app.get("/api/projects", (c) => c.json(store.snapshot()));

  app.post("/api/projects/rescan", async (c) => {
    await orchestrator.rescan();
    return c.json(store.snapshot());
  });

  const actions = {
    start: (id: string) => orchestrator.start(id),
    stop: (id: string) => orchestrator.stop(id),
    rebuild: (id: string) => orchestrator.rebuild(id),
    "restart-opencode": (id: string) => orchestrator.restartOpencode(id),
  } as const;

  for (const [route, run] of Object.entries(actions)) {
    app.post(`/api/projects/:id/${route}`, (c) => {
      if (store.preflight().errors.length > 0) {
        return c.json({ error: store.preflight().errors.join("; ") }, 412);
      }
      try {
        run(c.req.param("id")).catch(() => {});
        return c.json({ accepted: true }, 202);
      } catch (err) {
        if (err instanceof BusyError)
          return c.json({ error: err.message }, 409);
        if (err instanceof NotFoundError)
          return c.json({ error: err.message }, 404);
        throw err;
      }
    });
  }

  app.get("/api/projects/:id/logs", (c) =>
    c.json({ lines: orchestrator.logLines(c.req.param("id")) })
  );

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const sendSnapshot = () =>
        stream.writeSSE({
          event: "snapshot",
          data: JSON.stringify(store.snapshot()),
        });
      await sendSnapshot();
      let pending: ReturnType<typeof setTimeout> | undefined;
      const unsubscribe = store.subscribe(() => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = undefined;
          void sendSnapshot();
        }, 50);
      });
      const unlisten = orchestrator.onLog((projectId, line) => {
        const event: LogEvent = { projectId, line };
        void stream.writeSSE({ event: "log", data: JSON.stringify(event) });
      });
      const heartbeat = setInterval(
        () => void stream.writeSSE({ event: "ping", data: "" }),
        15_000
      );
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(heartbeat);
      clearTimeout(pending);
      unsubscribe();
      unlisten();
    })
  );

  const webDir = deps.webDir;
  if (!webDir) {
    app.get("*", (c) =>
      c.text(
        "opendevhub UI is not built. Run `npm run build`, or `npm run dev:web` during development.",
        503
      )
    );
    return app;
  }

  app.get("*", async (c) => {
    const rel = decodeURIComponent(new URL(c.req.url).pathname);
    let file = path.join(webDir, path.normalize(rel));
    if (file !== webDir && !file.startsWith(webDir + path.sep))
      return c.notFound();
    const stat = await fs.stat(file).catch(() => undefined);
    if (!stat?.isFile()) file = path.join(webDir, "index.html");
    const body = await fs.readFile(file);
    return c.body(new Uint8Array(body), 200, {
      "content-type":
        CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
    });
  });

  return app;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/server/dashboard-api.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/dashboard-api.ts test/server/dashboard-api.test.ts
git commit -m "feat: dashboard REST + SSE API and static SPA serving"
```

---

### Task 13: Server assembly, preflight and CLI

**Files:**

- Create: `src/server/server.ts`, `src/server/preflight.ts`, `src/server/cli.ts`, `src/server/bin.ts`, `tsup.config.ts`
- Test: `test/server/server.test.ts`, `test/server/preflight.test.ts`, `test/server/cli.test.ts`

**Interfaces:**

- Consumes: everything above.
- Produces:
  - `startServer(opts: { port: number; app: FetchApp; resolveTarget: ResolveTarget }): Promise<{ url: string; port: number; close(): Promise<void> }>` — binds `127.0.0.1`; `port: 0` picks a free port.
  - `preflight(run: Runner): Promise<Preflight>`
  - `parseCli(argv: string[]): { roots: string[]; port?: number; open: boolean; help: boolean }` (throws on invalid input)
  - `main(argv?: string[]): Promise<void>`
  - `findWebDir(): string | undefined`

- [ ] **Step 1: Write the failing tests**

`test/server/server.test.ts`:

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProxyTarget } from "../../src/server/proxy";
import { startServer } from "../../src/server/server";

let upstream: http.Server;
let upstreamPort: number;
let server: Awaited<ReturnType<typeof startServer>>;
let targets: Record<string, ProxyTarget>;

function get(
  port: number,
  host: string,
  path: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, headers: { host } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  upstream = http.createServer((req, res) =>
    res.end(`upstream ${req.headers.authorization}`)
  );
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  upstreamPort = (upstream.address() as AddressInfo).port;
  targets = {
    "demo-abc123": { host: "127.0.0.1", port: upstreamPort, password: "pw" },
  };
  const app = new Hono().get("/api/ping", (c) => c.text("pong"));
  server = await startServer({
    port: 0,
    app,
    resolveTarget: (id) => targets[id],
  });
});
afterEach(async () => {
  await server.close();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
});

describe("startServer", () => {
  it("routes the dashboard host to the Hono app", async () => {
    expect(
      await get(server.port, `localhost:${server.port}`, "/api/ping")
    ).toEqual({ status: 200, body: "pong" });
    expect(server.url).toBe(`http://localhost:${server.port}/`);
  });

  it("proxies project subdomains with injected auth", async () => {
    const res = await get(
      server.port,
      `Demo-ABC123.localhost:${server.port}`,
      "/"
    );
    expect(res.body).toBe(
      `upstream Basic ${Buffer.from("opencode:pw").toString("base64")}`
    );
  });

  it("returns 503 for unknown or stopped projects", async () => {
    expect(
      (await get(server.port, `other-000000.localhost:${server.port}`, "/"))
        .status
    ).toBe(503);
  });

  it("rejects foreign hosts with 421 (DNS rebinding)", async () => {
    expect(
      (await get(server.port, `evil.example:${server.port}`, "/api/ping"))
        .status
    ).toBe(421);
  });
});
```

`test/server/preflight.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { preflight } from "../../src/server/preflight";
import { fakeRunner } from "../helpers/fake-runner";

describe("preflight", () => {
  it("passes when docker and devcontainer work", async () => {
    expect(await preflight(fakeRunner().run)).toEqual({ errors: [] });
  });
  it("reports a missing docker CLI, an unreachable daemon and a missing devcontainer CLI", async () => {
    const missing = fakeRunner(() => ({ exitCode: 127 }));
    expect((await preflight(missing.run)).errors).toEqual([
      "docker CLI not found on PATH",
      "devcontainer CLI not found on PATH — install it with `npm i -g @devcontainers/cli`",
    ]);
    const down = fakeRunner((c) => (c.cmd === "docker" ? { exitCode: 1 } : {}));
    expect((await preflight(down.run)).errors).toEqual([
      "Docker daemon is not reachable — is Docker running?",
    ]);
  });
});
```

`test/server/cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseCli } from "../../src/server/cli";

describe("parseCli", () => {
  it("parses repeated roots, port and --no-open", () => {
    expect(
      parseCli([
        "--root",
        "~/code",
        "-r",
        "/work",
        "--port",
        "9000",
        "--no-open",
      ])
    ).toEqual({
      roots: ["~/code", "/work"],
      port: 9000,
      open: false,
      help: false,
    });
  });
  it("defaults", () => {
    expect(parseCli([])).toEqual({
      roots: [],
      port: undefined,
      open: true,
      help: false,
    });
  });
  it.each([["--port", "abc"], ["--port", "70000"], ["--bogus"]])(
    "rejects %s",
    (...argv) => {
      expect(() => parseCli(argv)).toThrow();
    }
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/server/server.test.ts test/server/preflight.test.ts test/server/cli.test.ts` Expected: FAIL — modules not found.

- [ ] **Step 3: Implement server and preflight**

`src/server/server.ts`:

```ts
import http from "node:http";
import type { AddressInfo } from "node:net";

import { getRequestListener } from "@hono/node-server";

import { classifyHost } from "./hosts";
import { type ResolveTarget, proxyRequest, proxyUpgrade } from "./proxy";

export interface ServerHandle {
  url: string;
  port: number;
  close(): Promise<void>;
}

export interface FetchApp {
  fetch: (request: Request) => Response | Promise<Response>;
}

export async function startServer(opts: {
  port: number;
  app: FetchApp;
  resolveTarget: ResolveTarget;
}): Promise<ServerHandle> {
  const dashboard = getRequestListener(opts.app.fetch);
  let port = opts.port;
  const dashboardUrl = () => `http://localhost:${port}/`;

  const server = http.createServer((req, res) => {
    const route = classifyHost(req.headers.host, port);
    if (route.kind === "dashboard") return void dashboard(req, res);
    if (route.kind === "project")
      return proxyRequest(
        req,
        res,
        route.projectId,
        opts.resolveTarget,
        dashboardUrl()
      );
    res.writeHead(421, { "content-type": "text/plain" });
    res.end("Misdirected Request");
  });
  server.on("upgrade", (req, socket, head) => {
    const route = classifyHost(req.headers.host, port);
    if (route.kind === "project")
      return proxyUpgrade(
        req,
        socket,
        head,
        route.projectId,
        opts.resolveTarget
      );
    socket.end("HTTP/1.1 421 Misdirected Request\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`port ${opts.port} is already in use — pass --port <n>`)
          : err
      )
    );
    server.listen(opts.port, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: dashboardUrl(),
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

`src/server/preflight.ts`:

```ts
import type { Preflight } from "../shared/types";
import type { Runner } from "./exec";

export async function preflight(run: Runner): Promise<Preflight> {
  const errors: string[] = [];
  const docker = await run(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    { timeoutMs: 15_000 }
  );
  if (docker.exitCode === 127) errors.push("docker CLI not found on PATH");
  else if (docker.exitCode !== 0)
    errors.push("Docker daemon is not reachable — is Docker running?");
  const devcontainer = await run("devcontainer", ["--version"], {
    timeoutMs: 15_000,
  });
  if (devcontainer.exitCode !== 0) {
    errors.push(
      "devcontainer CLI not found on PATH — install it with `npm i -g @devcontainers/cli`"
    );
  }
  return { errors };
}
```

- [ ] **Step 4: Implement the CLI**

`src/server/cli.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import open from "open";

import {
  configDir,
  loadConfig,
  loadState,
  mergeRoots,
  saveConfig,
  saveState,
} from "./config";
import { Containers } from "./containers";
import { createDashboardApp } from "./dashboard-api";
import { scanRoots } from "./discovery";
import { spawnRunner } from "./exec";
import { OpencodeClient } from "./opencode/client";
import { OPENCODE_PORT, OpencodeRuntime } from "./opencode/runtime";
import { Orchestrator } from "./orchestrator";
import { preflight } from "./preflight";
import { startServer } from "./server";
import { StateStore } from "./state";

const USAGE = `Usage: opendevhub [--root <dir>]... [--port <n>] [--no-open]

  -r, --root <dir>   Directory to scan for devcontainer projects (repeatable, saved)
  -p, --port <n>     Dashboard port (default 7777, saved)
      --no-open      Do not open the browser
  -h, --help         Show this help`;

export interface CliOptions {
  roots: string[];
  port?: number;
  open: boolean;
  help: boolean;
}

export function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: "string", short: "r", multiple: true },
      port: { type: "string", short: "p" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  ) {
    throw new Error(`invalid --port: ${values.port}`);
  }
  return {
    roots: values.root ?? [],
    port,
    open: !values["no-open"],
    help: values.help === true,
  };
}

export function findWebDir(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.join(here, "web"),
    path.resolve(here, "../../dist/web"),
  ]) {
    if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
  }
  return undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseCli(argv);
  } catch (err) {
    console.error((err as Error).message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const dir = configDir();
  const saved = loadConfig(dir);
  const config = {
    roots: mergeRoots(saved.roots, opts.roots),
    port: opts.port ?? saved.port,
  };
  saveConfig(dir, config);
  if (config.roots.length === 0) {
    console.error(
      "No project roots configured yet. Run: opendevhub --root ~/code"
    );
    process.exitCode = 2;
    return;
  }

  const store = new StateStore({
    port: config.port,
    persisted: loadState(dir),
    persist: (s) => saveState(dir, s),
  });
  store.setRoots(config.roots);
  const containers = new Containers(spawnRunner);
  const clientFor = (ep: { baseUrl: string; password: string }) =>
    new OpencodeClient(ep);
  const runtime = new OpencodeRuntime({ containers, clientFor });
  const orchestrator = new Orchestrator({
    store,
    containers,
    runtime,
    clientFor,
    roots: () => config.roots,
    scan: (roots) => scanRoots(roots),
  });

  store.setPreflight(await preflight(spawnRunner));
  await orchestrator.rescan();
  if (store.preflight().errors.length === 0) await orchestrator.adopt();

  const app = createDashboardApp({ store, orchestrator, webDir: findWebDir() });
  const server = await startServer({
    port: config.port,
    app,
    resolveTarget: (id) => {
      const rt = store.runtime(id);
      if (rt.containerState !== "running" || !rt.containerIp || !rt.password)
        return undefined;
      return {
        host: rt.containerIp,
        port: OPENCODE_PORT,
        password: rt.password,
      };
    },
  });
  const refresh = setInterval(
    () => void orchestrator.refreshContainers(),
    10_000
  );

  console.log(`opendevhub running at ${server.url}`);
  for (const e of store.preflight().errors) console.warn(`warning: ${e}`);
  if (opts.open) await open(server.url).catch(() => {});

  const shutdown = async () => {
    clearInterval(refresh);
    orchestrator.shutdown();
    await server.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}
```

`src/server/bin.ts`:

```ts
import { main } from "./cli";

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

`tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: false,
  banner: { js: "#!/usr/bin/env node" },
});
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit` Expected: all PASS.

- [ ] **Step 6: Smoke-run the CLI without a UI build**

Run: `XDG_CONFIG_HOME=$(mktemp -d) npx tsx src/server/bin.ts --root . --port 7788 --no-open` (in a second terminal: `curl -s -H 'Host: localhost:7788' http://127.0.0.1:7788/api/projects`), then Ctrl-C. Expected: prints `opendevhub running at http://localhost:7788/`; curl returns JSON with `"projects":[]` (this repo has no devcontainer) and preflight errors only if Docker/devcontainer are missing.

- [ ] **Step 7: Commit**

```bash
git add src/server/server.ts src/server/preflight.ts src/server/cli.ts src/server/bin.ts tsup.config.ts test/server/server.test.ts test/server/preflight.test.ts test/server/cli.test.ts
git commit -m "feat: host-routed server, preflight checks and CLI entry"
```

---

### Task 14: Web dashboard

**Files:**

- Create: `vite.config.ts`, `src/web/index.html`, `src/web/main.tsx`, `src/web/App.tsx`, `src/web/api.ts`, `src/web/useDashboard.ts`, `src/web/derive.ts`, `src/web/styles.css`, `src/web/components/ProjectCard.tsx`, `src/web/components/SessionRow.tsx`, `src/web/components/LogPanel.tsx`
- Test: `test/web/derive.test.ts`

**Interfaces:**

- Consumes: shared types, `sessionUrl` (Task 1); dashboard API routes and SSE events (Task 12).
- Produces (in `derive.ts`):
  - `interface Notice { key: string; title: string; body: string; projectId: string; sessionId: string }`
  - `diffForNotifications(prev: DashboardSnapshot | undefined, next: DashboardSnapshot): Notice[]` — no notices on the first snapshot; `needs-permission`/`needs-answer` on entering that state; "finished" on `running → idle`.
  - `attentionCounts(s: DashboardSnapshot): { attention: number; running: number }`
  - `relativeTime(ts: number, now?: number): string`

- [ ] **Step 1: Write the failing tests**

`test/web/derive.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type { DashboardSnapshot, SessionStatus } from "../../src/shared/types";
import {
  attentionCounts,
  diffForNotifications,
  relativeTime,
} from "../../src/web/derive";

function snap(statuses: Record<string, SessionStatus>): DashboardSnapshot {
  return {
    roots: [],
    preflight: { errors: [] },
    projects: [
      {
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

describe("diffForNotifications", () => {
  it("never notifies on the first snapshot, even if sessions need attention", () => {
    expect(
      diffForNotifications(
        undefined,
        snap({ a: "needs-permission", b: "needs-answer" })
      )
    ).toEqual([]);
  });

  it("notifies on entering needs-permission / needs-answer and on running -> idle", () => {
    const notices = diffForNotifications(
      snap({ a: "running", b: "running", c: "running", d: "idle" }),
      snap({ a: "needs-permission", b: "needs-answer", c: "idle", d: "idle" })
    );
    expect(notices.map((n) => [n.sessionId, n.title])).toEqual([
      ["a", "demo: permission needed"],
      ["b", "demo: question waiting"],
      ["c", "demo: finished"],
    ]);
    expect(notices[0].body).toBe("T a");
  });

  it("does not repeat while the state is unchanged, and ignores new idle sessions", () => {
    expect(
      diffForNotifications(
        snap({ a: "needs-permission" }),
        snap({ a: "needs-permission", z: "idle" })
      )
    ).toEqual([]);
  });
});

describe("attentionCounts", () => {
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
    ).toEqual({
      attention: 2,
      running: 1,
    });
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000;
  it.each([
    [now - 10_000, "just now"],
    [now - 5 * 60_000, "5 min ago"],
    [now - 3 * 3_600_000, "3 h ago"],
    [now - 2 * 86_400_000, "2 d ago"],
    [now + 5000, "just now"],
  ])("%d", (ts, expected) => expect(relativeTime(ts, now)).toBe(expected));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/web/derive.test.ts` Expected: FAIL — module not found.

- [ ] **Step 3: Implement `derive.ts`**

`src/web/derive.ts`:

```ts
import type {
  DashboardSnapshot,
  SessionStatus,
  SessionSummary,
} from "../shared/types";

export interface Notice {
  key: string;
  title: string;
  body: string;
  projectId: string;
  sessionId: string;
}

const MESSAGES: Partial<Record<SessionStatus, string>> = {
  "needs-permission": "permission needed",
  "needs-answer": "question waiting",
};

export function diffForNotifications(
  prev: DashboardSnapshot | undefined,
  next: DashboardSnapshot
): Notice[] {
  if (!prev) return [];
  const before = new Map<string, SessionSummary>();
  for (const view of prev.projects)
    for (const s of view.sessions) before.set(s.id, s);

  const notices: Notice[] = [];
  for (const view of next.projects) {
    for (const s of view.sessions) {
      const old = before.get(s.id)?.status;
      let what: string | undefined;
      if (MESSAGES[s.status] && old !== s.status) what = MESSAGES[s.status];
      else if (s.status === "idle" && old === "running") what = "finished";
      if (!what) continue;
      notices.push({
        key: `${s.id}:${s.status}`,
        title: `${view.project.name}: ${what}`,
        body: s.title,
        projectId: view.project.id,
        sessionId: s.id,
      });
    }
  }
  return notices;
}

export function attentionCounts(snapshot: DashboardSnapshot): {
  attention: number;
  running: number;
} {
  let attention = 0;
  let running = 0;
  for (const view of snapshot.projects) {
    for (const s of view.sessions) {
      if (s.status === "needs-permission" || s.status === "needs-answer")
        attention++;
      else if (s.status === "running") running++;
    }
  }
  return { attention, running };
}

export function relativeTime(ts: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
```

Run: `npx vitest run test/web/derive.test.ts` Expected: PASS.

- [ ] **Step 4: Add Vite config, HTML entry, API client and hook**

`vite.config.ts`:

```ts
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: { outDir: "../../dist/web", emptyOutDir: true },
  server: {
    proxy: { "/api": { target: "http://localhost:7777", changeOrigin: true } },
  },
});
```

`src/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>opendevhub</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

`src/web/main.tsx`:

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

`src/web/api.ts`:

```ts
import type { DashboardSnapshot, LogEvent } from "../shared/types";

export type Action = "start" | "stop" | "rebuild" | "restart-opencode";

async function failure(res: Response, what: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `${what} failed (${res.status})`);
}

export async function postAction(
  projectId: string,
  action: Action
): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/${action}`,
    { method: "POST" }
  );
  if (!res.ok) throw await failure(res, action);
}

export async function rescan(): Promise<DashboardSnapshot> {
  const res = await fetch("/api/projects/rescan", { method: "POST" });
  if (!res.ok) throw await failure(res, "rescan");
  return (await res.json()) as DashboardSnapshot;
}

export async function fetchLogs(projectId: string): Promise<string[]> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/logs`
  );
  if (!res.ok) throw await failure(res, "logs");
  return ((await res.json()) as { lines: string[] }).lines;
}

export function subscribe(handlers: {
  onSnapshot: (s: DashboardSnapshot) => void;
  onLog: (e: LogEvent) => void;
  onConnection: (connected: boolean) => void;
}): () => void {
  const source = new EventSource("/api/events");
  source.addEventListener("snapshot", (e) =>
    handlers.onSnapshot(JSON.parse((e as MessageEvent<string>).data))
  );
  source.addEventListener("log", (e) =>
    handlers.onLog(JSON.parse((e as MessageEvent<string>).data))
  );
  source.onopen = () => handlers.onConnection(true);
  source.onerror = () => handlers.onConnection(false);
  return () => source.close();
}
```

`src/web/useDashboard.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";

import type { DashboardSnapshot } from "../shared/types";
import { fetchLogs, subscribe } from "./api";
import { type Notice, diffForNotifications } from "./derive";

function showNotification(notice: Notice, onClick: () => void): void {
  if (
    typeof Notification === "undefined" ||
    Notification.permission !== "granted"
  )
    return;
  const n = new Notification(notice.title, {
    body: notice.body,
    tag: notice.key,
  });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}

export function useDashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [highlight, setHighlight] = useState<string>();
  const previous = useRef<DashboardSnapshot | undefined>(undefined);

  useEffect(
    () =>
      subscribe({
        onSnapshot: (next) => {
          for (const notice of diffForNotifications(previous.current, next)) {
            showNotification(notice, () => setHighlight(notice.sessionId));
          }
          previous.current = next;
          setSnapshot(next);
        },
        onLog: ({ projectId, line }) =>
          setLogs((all) => ({
            ...all,
            [projectId]: [...(all[projectId] ?? []), line].slice(-500),
          })),
        onConnection: setConnected,
      }),
    []
  );

  const loadLogs = useCallback(async (projectId: string) => {
    const lines = await fetchLogs(projectId);
    setLogs((all) => ({ ...all, [projectId]: lines }));
  }, []);

  return { snapshot, connected, logs, loadLogs, highlight };
}
```

- [ ] **Step 5: Add components, App and styles**

`src/web/components/LogPanel.tsx`:

```tsx
import { useEffect, useRef } from "react";

export function LogPanel({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);
  return (
    <pre className="logs" ref={ref}>
      {lines.length > 0 ? lines.join("\n") : "No output yet."}
    </pre>
  );
}
```

`src/web/components/SessionRow.tsx`:

```tsx
import type { SessionStatus, SessionSummary } from "../../shared/types";
import { relativeTime } from "../derive";

const BADGE: Record<SessionStatus, string> = {
  "needs-permission": "Needs permission",
  "needs-answer": "Question waiting",
  running: "Running",
  idle: "Idle",
};

export function SessionRow(props: {
  session: SessionSummary;
  openUrl: string;
  highlighted: boolean;
}) {
  const { session, openUrl, highlighted } = props;
  return (
    <li className={`session${highlighted ? " highlight" : ""}`}>
      <span className={`badge status-${session.status}`}>
        {BADGE[session.status]}
      </span>
      <span className="session-title">{session.title}</span>
      <span className="muted">{relativeTime(session.updatedAt)}</span>
      <a href={openUrl} target="_blank" rel="noreferrer">
        Open ↗
      </a>
    </li>
  );
}
```

`src/web/components/ProjectCard.tsx`:

```tsx
import { useState } from "react";

import type { ContainerState, ProjectView } from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import type { Action } from "../api";
import { LogPanel } from "./LogPanel";
import { SessionRow } from "./SessionRow";

const STATE_LABEL: Record<ContainerState, string> = {
  stopped: "Stopped",
  starting: "Starting…",
  running: "Running",
  stopping: "Stopping…",
  error: "Error",
};

export function ProjectCard(props: {
  view: ProjectView;
  disabled: boolean;
  logs: string[] | undefined;
  highlight: string | undefined;
  onAction: (action: Action) => void;
  onLoadLogs: () => void;
}) {
  const { view, disabled, logs, highlight, onAction, onLoadLogs } = props;
  const { project, runtime, sessions, openUrl } = view;
  const [showLogs, setShowLogs] = useState(false);
  const running = runtime.containerState === "running";
  const transitioning =
    runtime.containerState === "starting" ||
    runtime.containerState === "stopping" ||
    runtime.opencode === "starting";
  const canOpen = running && runtime.opencode === "healthy";
  const locked = disabled || transitioning;

  return (
    <li className="card">
      <div className="card-head">
        <div>
          <h2>{project.name}</h2>
          <p className="muted path">{project.path}</p>
        </div>
        <div className="pills">
          <span className={`pill state-${runtime.containerState}`}>
            {STATE_LABEL[runtime.containerState]}
          </span>
          {running && (
            <span className={`pill oc-${runtime.opencode}`}>
              opencode {runtime.opencode}
              {runtime.opencodeVersion ? ` · v${runtime.opencodeVersion}` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="actions">
        {running ? (
          <button disabled={locked} onClick={() => onAction("stop")}>
            Stop
          </button>
        ) : (
          <button disabled={locked} onClick={() => onAction("start")}>
            Start
          </button>
        )}
        <button disabled={locked} onClick={() => onAction("rebuild")}>
          Rebuild
        </button>
        {running && runtime.opencode === "unhealthy" && (
          <button
            disabled={locked}
            onClick={() => onAction("restart-opencode")}
          >
            Restart opencode
          </button>
        )}
        <a
          className={`button primary${canOpen ? "" : " disabled"}`}
          href={canOpen ? openUrl : undefined}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!canOpen}
        >
          Open in opencode ↗
        </a>
        <button
          className="link"
          onClick={() => {
            if (!showLogs) onLoadLogs();
            setShowLogs(!showLogs);
          }}
        >
          {showLogs ? "Hide logs" : "Logs"}
        </button>
      </div>

      {runtime.error && <p className="error-text">{runtime.error}</p>}

      {sessions.length > 0 && (
        <ul className="sessions">
          {sessions.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              openUrl={sessionUrl(openUrl, s.id)}
              highlighted={s.id === highlight}
            />
          ))}
        </ul>
      )}
      {canOpen && sessions.length === 0 && (
        <p className="muted">No sessions yet — open opencode to start one.</p>
      )}
      {showLogs && <LogPanel lines={logs ?? []} />}
    </li>
  );
}
```

`src/web/App.tsx`:

```tsx
import { useState } from "react";

import { type Action, postAction, rescan } from "./api";
import { ProjectCard } from "./components/ProjectCard";
import { attentionCounts } from "./derive";
import { useDashboard } from "./useDashboard";

type Permission = NotificationPermission | "unsupported";

export function App() {
  const { snapshot, connected, logs, loadLogs, highlight } = useDashboard();
  const [actionError, setActionError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [permission, setPermission] = useState<Permission>(() =>
    typeof Notification === "undefined"
      ? "unsupported"
      : Notification.permission
  );

  if (!snapshot) {
    return (
      <main className="app">
        <p className="muted">
          {connected ? "Loading…" : "Connecting to opendevhub…"}
        </p>
      </main>
    );
  }

  const counts = attentionCounts(snapshot);
  const blocked = snapshot.preflight.errors.length > 0;
  const act = (projectId: string, action: Action) =>
    postAction(projectId, action).then(
      () => setActionError(undefined),
      (err: Error) => setActionError(err.message)
    );
  const doRescan = () => {
    setScanning(true);
    rescan()
      .catch((err: Error) => setActionError(err.message))
      .finally(() => setScanning(false));
  };

  return (
    <main className="app">
      <header className="top">
        <div>
          <h1>opendevhub</h1>
          <p className="muted">{snapshot.roots.join(" · ")}</p>
        </div>
        <div className="top-actions">
          <span className={`summary${counts.attention > 0 ? " hot" : ""}`}>
            {counts.attention} need attention · {counts.running} running
          </span>
          {permission === "default" && (
            <button
              onClick={() =>
                void Notification.requestPermission().then(setPermission)
              }
            >
              Enable notifications
            </button>
          )}
          <button disabled={scanning} onClick={doRescan}>
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </header>

      {!connected && (
        <div className="banner warn">
          Lost connection to opendevhub — retrying…
        </div>
      )}
      {snapshot.preflight.errors.map((e) => (
        <div key={e} className="banner error">
          {e}
        </div>
      ))}
      {actionError && <div className="banner error">{actionError}</div>}

      {snapshot.projects.length === 0 ? (
        <p className="muted">
          No projects with a devcontainer found under the configured roots.
        </p>
      ) : (
        <ul className="projects">
          {snapshot.projects.map((view) => (
            <ProjectCard
              key={view.project.id}
              view={view}
              disabled={blocked}
              logs={logs[view.project.id]}
              highlight={highlight}
              onAction={(a) => void act(view.project.id, a)}
              onLoadLogs={() => void loadLogs(view.project.id)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}
```

`src/web/styles.css`:

```css
:root {
  --bg: #f6f7f9;
  --surface: #ffffff;
  --text: #1b1f24;
  --muted: #5f6b7a;
  --border: #dde2e8;
  --accent: #2f6fed;
  --ok: #1f8a4c;
  --warn: #b7791f;
  --danger: #c53030;
  --attention: #d9480f;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111418;
    --surface: #1a1e24;
    --text: #e6e9ee;
    --muted: #9aa5b4;
    --border: #2c323b;
    --accent: #6c9bff;
    --ok: #4cc485;
    --warn: #e0a84f;
    --danger: #f07171;
    --attention: #ff8a4c;
  }
}
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font:
    14px/1.45 system-ui,
    sans-serif;
}
.app {
  max-width: 60rem;
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
}
h1 {
  font-size: 1.4rem;
  margin: 0;
}
h2 {
  font-size: 1.05rem;
  margin: 0;
}
.muted {
  color: var(--muted);
  margin: 0;
}
.path {
  font-family: ui-monospace, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.top-actions {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.summary {
  color: var(--muted);
}
.summary.hot {
  color: var(--attention);
  font-weight: 600;
}
button,
.button {
  font: inherit;
  padding: 0.35rem 0.8rem;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  text-decoration: none;
  display: inline-block;
}
button:disabled,
.button.disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}
.button.primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
button.link {
  border: none;
  background: none;
  color: var(--accent);
  padding-inline: 0.3rem;
}
.banner {
  padding: 0.6rem 0.8rem;
  border-radius: 6px;
  margin-bottom: 0.75rem;
  border: 1px solid;
}
.banner.error {
  border-color: var(--danger);
  color: var(--danger);
}
.banner.warn {
  border-color: var(--warn);
  color: var(--warn);
}
.projects,
.sessions {
  list-style: none;
  margin: 0;
  padding: 0;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 1rem;
  margin-bottom: 0.75rem;
}
.card-head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.pills {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  align-items: flex-start;
}
.pill {
  font-size: 12px;
  padding: 0.1rem 0.55rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  white-space: nowrap;
}
.state-running,
.oc-healthy {
  color: var(--ok);
  border-color: var(--ok);
}
.state-starting,
.state-stopping,
.oc-starting {
  color: var(--warn);
  border-color: var(--warn);
}
.state-error,
.oc-unhealthy {
  color: var(--danger);
  border-color: var(--danger);
}
.actions {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-top: 0.75rem;
  align-items: center;
}
.error-text {
  color: var(--danger);
  margin: 0.6rem 0 0;
}
.sessions {
  margin-top: 0.75rem;
  border-top: 1px solid var(--border);
}
.session {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  gap: 0.75rem;
  align-items: center;
  padding: 0.45rem 0;
  border-bottom: 1px solid var(--border);
}
.session.highlight {
  background: color-mix(in srgb, var(--attention) 12%, transparent);
}
.session-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session a {
  color: var(--accent);
  text-decoration: none;
}
.badge {
  font-size: 12px;
  padding: 0.1rem 0.5rem;
  border-radius: 4px;
  white-space: nowrap;
  border: 1px solid var(--border);
}
.status-needs-permission,
.status-needs-answer {
  background: var(--attention);
  border-color: var(--attention);
  color: #fff;
}
.status-running {
  color: var(--accent);
  border-color: var(--accent);
}
.status-idle {
  color: var(--muted);
}
.logs {
  margin: 0.75rem 0 0;
  max-height: 18rem;
  overflow: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.6rem;
  font-size: 12px;
  white-space: pre-wrap;
}
@media (max-width: 36rem) {
  .session {
    grid-template-columns: auto 1fr;
  }
}
```

- [ ] **Step 6: Typecheck, test and build**

Run: `npx tsc --noEmit && npx vitest run && npm run build` Expected: no type errors; all tests PASS; `dist/web/index.html` and `dist/bin.js` exist.

- [ ] **Step 7: Manual UI check**

Run: `XDG_CONFIG_HOME=$(mktemp -d) node dist/bin.js --root <a dir containing at least one devcontainer project> --port 7788` Expected: the browser opens `http://localhost:7788/`; the project list renders; with Docker stopped a red preflight banner appears and the buttons are disabled; "Logs" toggles an empty log panel; the layout has no horizontal scroll at 375px width; dark mode follows the OS setting.

- [ ] **Step 8: Commit**

```bash
git add vite.config.ts src/web test/web
git commit -m "feat: React dashboard with live status, actions and notifications"
```

---

### Task 15: End-to-end test, open-item verification, README

**Files:**

- Create: `vitest.e2e.config.ts`, `test/e2e/fixture/.devcontainer/devcontainer.json`, `test/e2e/opendevhub.e2e.ts`, `README.md`
- Modify (conditionally, Step 5): `src/shared/urls.ts`, plus a new `test/shared/urls.test.ts`

**Interfaces:**

- Consumes: all server modules.

- [ ] **Step 1: Add the E2E fixture and config**

`test/e2e/fixture/.devcontainer/devcontainer.json`:

```json
{
  "name": "opendevhub-e2e",
  "image": "mcr.microsoft.com/devcontainers/javascript-node:22",
  "postCreateCommand": "npm i -g @opencode/cli@2"
}
```

`vitest.e2e.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    environment: "node",
    testTimeout: 20 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
```

- [ ] **Step 2: Write the E2E test**

`test/e2e/opendevhub.e2e.ts`:

```ts
import http from "node:http";
import path from "node:path";

import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { Containers } from "../../src/server/containers";
import { spawnRunner } from "../../src/server/exec";
import { projectId } from "../../src/server/ids";
import { OpencodeClient, basicAuth } from "../../src/server/opencode/client";
import {
  OPENCODE_PORT,
  OpencodeRuntime,
} from "../../src/server/opencode/runtime";
import { Orchestrator } from "../../src/server/orchestrator";
import { startServer } from "../../src/server/server";
import { StateStore } from "../../src/server/state";
import type { Project } from "../../src/shared/types";

const fixture = path.resolve("test/e2e/fixture");

function getViaHost(
  port: number,
  host: string,
  urlPath: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(
        { host: "127.0.0.1", port, path: urlPath, headers: { host } },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve(body));
        }
      )
      .on("error", reject);
  });
}

describe.skipIf(!process.env.OPENDEVHUB_E2E)(
  "e2e: real devcontainer + opencode v2",
  () => {
    it("starts, reports sessions, proxies and stops", async () => {
      const project: Project = {
        id: projectId(fixture),
        name: "fixture",
        path: fixture,
        devcontainerPath: path.join(fixture, ".devcontainer/devcontainer.json"),
      };
      const store = new StateStore({
        port: 0,
        persisted: { projects: {} },
        persist: () => {},
      });
      const containers = new Containers(spawnRunner);
      const clientFor = (ep: { baseUrl: string; password: string }) =>
        new OpencodeClient(ep);
      const runtime = new OpencodeRuntime({ containers, clientFor });
      const orch = new Orchestrator({
        store,
        containers,
        runtime,
        clientFor,
        roots: () => [],
        scan: async () => [project],
      });
      orch.onLog((_id, line) => console.log(`[e2e] ${line}`));

      await orch.rescan();
      await orch.start(project.id);
      const rt = store.runtime(project.id);
      expect(rt.error).toBeUndefined();
      expect(rt).toMatchObject({
        containerState: "running",
        opencode: "healthy",
      });

      const ep = runtime.endpoint(rt.containerIp!, rt.password!);
      const created = await fetch(`${ep.baseUrl}/api/session`, {
        method: "POST",
        headers: {
          authorization: basicAuth(ep.password),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "e2e session",
          location: { directory: rt.workspaceFolder },
        }),
      });
      expect(created.ok).toBe(true);
      await vi.waitFor(
        () =>
          expect(
            store.snapshot().projects[0].sessions.map((s) => s.title)
          ).toContain("e2e session"),
        { timeout: 15_000 }
      );

      const server = await startServer({
        port: 0,
        app: new Hono(),
        resolveTarget: () => ({
          host: rt.containerIp!,
          port: OPENCODE_PORT,
          password: rt.password!,
        }),
      });
      const info = await getViaHost(
        server.port,
        `${project.id}.localhost:${server.port}`,
        "/api/info"
      );
      expect(JSON.parse(info).version).toMatch(/^2\./);
      const html = await getViaHost(
        server.port,
        `${project.id}.localhost:${server.port}`,
        "/"
      );
      expect(html).toContain("<html");
      await server.close();

      await orch.stop(project.id);
      expect(store.runtime(project.id).containerState).toBe("stopped");
      orch.shutdown();
    });
  }
);
```

- [ ] **Step 3: Run the E2E test**

Run: `npm run test:e2e` Expected: PASS (first run pulls the image and installs `@opencode/cli@2`; allow several minutes). If `opencode serve` dies once `devcontainer exec` returns (health times out; the log tail shows nothing), change the launch script in `src/server/opencode/runtime.ts` to prefix `setsid ` before `nohup`, re-run the unit tests (`npx vitest run test/server/opencode-runtime.test.ts`) and this E2E test.

- [ ] **Step 4: Verify the proxied opencode UI manually**

Run: `npm run build && XDG_CONFIG_HOME=$(mktemp -d) node dist/bin.js --root test/e2e --port 7788` In the dashboard: click Start on `fixture`, wait for "opencode healthy", click "Open in opencode ↗". Expected: `http://fixture-xxxxxx.localhost:7788/` loads opencode's web UI with **no** login prompt or pairing screen, and the terminal/PTY panel connects (WebSocket through the proxy). If the UI instead shows a pairing/login screen, stop and report back before continuing: the proxy then needs to redeem a pairing code (`POST /api/pair` → `/auth/connect/<code>`) on the first page load, which is a design change.

- [ ] **Step 5: Resolve the session deep link (spec §9 item 1)**

In the proxied opencode UI, open a session and copy the URL path. It has the form `/server/<key>/session/<id>`. In a Node REPL, compare `<key>` against `Buffer.from("http://fixture-xxxxxx.localhost:7788").toString("base64url")` (use the exact origin from the address bar).

If they match, replace `sessionUrl` in `src/shared/urls.ts`:

```ts
export function sessionUrl(projectBase: string, sessionId: string): string {
  const origin = projectBase.replace(/\/$/, "");
  const key = btoa(origin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${origin}/server/${key}/session/${sessionId}`;
}
```

and add `test/shared/urls.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { sessionUrl } from "../../src/shared/urls";

describe("sessionUrl", () => {
  it("builds opencode's per-session route for the project origin", () => {
    const base = "http://demo-abc123.localhost:7777/";
    const key = Buffer.from("http://demo-abc123.localhost:7777").toString(
      "base64url"
    );
    expect(sessionUrl(base, "ses_1")).toBe(
      `http://demo-abc123.localhost:7777/server/${key}/session/ses_1`
    );
  });
});
```

Run: `npx vitest run test/shared/urls.test.ts` → PASS; then click a session's "Open ↗" in the dashboard and confirm that exact session opens.

If they do not match, leave `sessionUrl` returning the project root and record the observed key format in the README's "Known limitations" section.

- [ ] **Step 6: Write the README**

`README.md`:

````markdown
# opendevhub

A local dashboard that orchestrates [opencode](https://opencode.ai) v2 agents, each running inside its project's devcontainer.

- Discovers projects with a `.devcontainer/devcontainer.json` (or `.devcontainer.json`) under your roots (up to 2 levels deep).
- Starts, stops and rebuilds one devcontainer per project and runs `opencode serve` inside it.
- Shows live session status (running, idle, needs permission, question waiting) and sends browser notifications.
- Opens each project's opencode web UI at `http://<project>.localhost:7777`, already authenticated.

## Requirements

- Linux (macOS support is planned)
- Docker, and the devcontainer CLI: `npm i -g @devcontainers/cli`
- Node.js 20 or newer
- opencode v2 installed in each project's devcontainer. For example, add `"postCreateCommand": "npm i -g @opencode/cli@2"` to the project's devcontainer.json.
- LLM provider credentials available inside the container (via `containerEnv`, `remoteEnv` or mounts). opendevhub does not manage credentials.

## Usage

```bash
npx opendevhub --root ~/code --root ~/work   # roots and port are remembered
npx opendevhub                               # reuse the saved roots
npx opendevhub --port 8080 --no-open
```

Containers keep running when opendevhub exits. The next time it starts, it reconnects to them.

## Development

```bash
npm install
npm test                # unit + integration tests
npm run test:e2e        # real devcontainer + opencode (slow, needs Docker)
npm run dev             # API server on :7777
npm run dev:web         # Vite dev server that proxies /api to :7777
npm run build           # dist/bin.js + dist/web
```

## Known limitations

- Linux only: the proxy connects to each container's bridge IP directly.
- Containers using `--network=host` are not supported.
- The opencode password is passed through `devcontainer exec --remote-env`, so other users on the same machine can see it in the process list while the command runs.
````

- [ ] **Step 7: Final verification and commit**

Run: `npx tsc --noEmit && npx vitest run && npm run build` Expected: all green.

```bash
git add vitest.e2e.config.ts test/e2e README.md src/shared/urls.ts test/shared
git commit -m "test: e2e against real devcontainer; docs: README"
```
