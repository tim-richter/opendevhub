# Add Project Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A **+** in the sidebar's Projects heading (and "Add project…" in `⌘K`) opens a dialog that lists git repos under the roots without a devcontainer, writes a stack-specific `.devcontainer/devcontainer.json` that installs opencode, and starts the new project.

**Architecture:** The stacks table and the template renderer live in `src/shared/stacks.ts`, so the dialog's preview and the server's file come from the same code. On the server, `discovery.ts` gets `scanCandidates` (sharing its directory walk with `scanRoots`), `stacks.ts` detects a repo's stack, and `onboarding.ts` validates a request against a fresh candidate scan and writes the file. Two dashboard routes call it, then rescan and start the project. On the web side, `AddProjectDialog` is opened through `DashboardContext`, like `NewTaskDialog`.

**Tech Stack:** TypeScript, Node 20 `fs/promises`, Hono, React 19, shadcn/ui (Dialog, Command, Select via `Choice`, SidebarGroupAction), vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-add-project-design.md`

**Deviations from the spec (decided while planning):**

- `GET /api/onboarding/candidates` returns `{ roots, candidates }` only. The client imports `STACKS` from `src/shared/stacks.ts` instead of receiving it.
- `POST /api/onboarding` answers `200` (through the existing `json` helper, like every other result route), not `201`.
- There is no toast library. When the project is written but not started, the dialog navigates and reports the reason through the existing error banner (`report`).
- The e2e test drives the HTTP route and a real orchestrator (the e2e suite has no browser), not the dialog.

## Global Constraints

- Images all come from `mcr.microsoft.com/devcontainers/…`: node `javascript-node:22`, python `python:3`, go `go:1`, rust `rust:1`, ruby `ruby:3`, java `java:21`, dotnet `dotnet:8.0`, php `php:8`, generic `base:ubuntu`.
- `postCreateCommand` is exactly `curl -fsSL https://opencode.ai/install | bash`.
- The generated file is `.devcontainer/devcontainer.json` with the keys `name`, `image` and `postCreateCommand` in that order, a 2-space indent and a trailing newline. It is never committed and never overwrites an existing file.
- The server writes only to a path that is exactly one of the current `scanCandidates(roots)` results. The client sends `{ path, stack }`, never file contents.
- The candidate walk uses the same rules as `scanRoots`: `maxDepth = 2`, skipping dotfolders, `node_modules` and `*.worktrees`, not descending into a project or a candidate.
- UI: Tailwind and shadcn/ui components only; match the existing dialog style (`NewTaskDialog`).
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work happens on `main`.

## Review Focus

1. **A path from the client that isn't a fresh candidate** (`..` segments, a trailing slash, a project's path, a repo below `maxDepth`, a symlink into a root) gives a 404 and writes nothing. Pinned in Task 4.
2. **A repo that gains a devcontainer between listing and confirming**, or two concurrent adds, never overwrites a file. The fresh scan gives 404, and the `wx` flag gives 409. Pinned in Task 4.
3. **A repo that is itself under a project**, for example a git submodule folder inside a project, is not offered. Pinned in Task 3.
4. **Preflight errors** (no docker or devcontainer CLI) still write the file and report `started: false` with the reason, instead of failing or starting. Pinned in Task 5.
5. **A repo with several markers** (a Python backend with a `package.json` for tooling) gets the first stack in the table's order, and the user can change it before writing. Pinned in Task 2, and the dialog's override comes in Task 6.

---

### Task 1: Shared stacks table and template

**Files:**
- Create: `src/shared/stacks.ts`
- Modify: `src/shared/types.ts` (add `Candidate`, `CandidateList`, `AddProjectResult`)
- Test: `test/shared/stacks.test.ts`

**Interfaces:**
- Produces:
  - `type StackId = "node" | "python" | "go" | "rust" | "ruby" | "java" | "dotnet" | "php" | "generic"`
  - `interface Stack { id: StackId; label: string; image: string }`
  - `const STACK_IDS: readonly StackId[]` (in table order)
  - `const STACKS: Record<StackId, Stack>`
  - `const OPENCODE_INSTALL: string`
  - `function isStackId(value: unknown): value is StackId`
  - `function renderDevcontainer(name: string, stack: StackId): string`
  - In `types.ts`: `interface Candidate { path: string; name: string; root: string; stack: StackId }`, `interface CandidateList { roots: string[]; candidates: Candidate[] }`, `interface AddProjectResult { projectId: ProjectId; started: boolean; error?: string }`

- [ ] **Step 1: Write the failing test**

```ts
// test/shared/stacks.test.ts
import { describe, expect, it } from "vitest";
import { isStackId, OPENCODE_INSTALL, renderDevcontainer, STACK_IDS, STACKS } from "../../src/shared/stacks";

describe("stacks", () => {
  it("has an mcr devcontainers image for every stack", () => {
    for (const id of STACK_IDS) {
      expect(STACKS[id].id).toBe(id);
      expect(STACKS[id].image).toMatch(/^mcr\.microsoft\.com\/devcontainers\/[a-z-]+:[\w.]+$/);
    }
    expect(STACKS.node.image).toBe("mcr.microsoft.com/devcontainers/javascript-node:22");
    expect(STACKS.generic.image).toBe("mcr.microsoft.com/devcontainers/base:ubuntu");
  });

  it("recognises stack ids only", () => {
    expect(isStackId("rust")).toBe(true);
    expect(isStackId("toString")).toBe(false);
    expect(isStackId(undefined)).toBe(false);
  });

  it("renders name, image and the opencode installer, in that order", () => {
    const text = renderDevcontainer("my-app", "python");
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["name", "image", "postCreateCommand"]);
    expect(JSON.parse(text)).toEqual({
      name: "my-app",
      image: "mcr.microsoft.com/devcontainers/python:3",
      postCreateCommand: "curl -fsSL https://opencode.ai/install | bash",
    });
    expect(OPENCODE_INSTALL).toBe("curl -fsSL https://opencode.ai/install | bash");
    expect(text).toContain('\n  "name": "my-app"');
  });

  it("escapes names that need it", () => {
    expect(JSON.parse(renderDevcontainer('we"ird', "generic")).name).toBe('we"ird');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/shared/stacks.test.ts`
Expected: FAIL, because `src/shared/stacks.ts` can't be resolved.

- [ ] **Step 3: Implement**

```ts
// src/shared/stacks.ts
/** Base images for repos opendevhub writes a devcontainer for, in detection order. */
export type StackId = "node" | "python" | "go" | "rust" | "ruby" | "java" | "dotnet" | "php" | "generic";

export interface Stack {
  id: StackId;
  label: string;
  image: string;
}

const MCR = "mcr.microsoft.com/devcontainers";

export const STACKS: Record<StackId, Stack> = {
  node: { id: "node", label: "Node.js", image: `${MCR}/javascript-node:22` },
  python: { id: "python", label: "Python", image: `${MCR}/python:3` },
  go: { id: "go", label: "Go", image: `${MCR}/go:1` },
  rust: { id: "rust", label: "Rust", image: `${MCR}/rust:1` },
  ruby: { id: "ruby", label: "Ruby", image: `${MCR}/ruby:3` },
  java: { id: "java", label: "Java", image: `${MCR}/java:21` },
  dotnet: { id: "dotnet", label: ".NET", image: `${MCR}/dotnet:8.0` },
  php: { id: "php", label: "PHP", image: `${MCR}/php:8` },
  generic: { id: "generic", label: "Other (Ubuntu)", image: `${MCR}/base:ubuntu` },
};

export const STACK_IDS = Object.keys(STACKS) as StackId[];

/** Works on every image above; opendevhub finds the binary in ~/.opencode/bin. */
export const OPENCODE_INSTALL = "curl -fsSL https://opencode.ai/install | bash";

export function isStackId(value: unknown): value is StackId {
  return typeof value === "string" && Object.hasOwn(STACKS, value);
}

/** The devcontainer.json opendevhub writes; the dialog previews the same text. */
export function renderDevcontainer(name: string, stack: StackId): string {
  return `${JSON.stringify({ name, image: STACKS[stack].image, postCreateCommand: OPENCODE_INSTALL }, null, 2)}\n`;
}
```

Append to `src/shared/types.ts`, and add `import type { StackId } from "./stacks";` at the top:

```ts
/** A git repo under a root that has no devcontainer yet. */
export interface Candidate {
  path: string;
  name: string;
  /** The root it was found under. */
  root: string;
  /** Detected from marker files; the user can pick another. */
  stack: StackId;
}

export interface CandidateList {
  roots: string[];
  candidates: Candidate[];
}

export interface AddProjectResult {
  projectId: ProjectId;
  started: boolean;
  /** Why the project wasn't started. */
  error?: string;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/shared/stacks.test.ts && npm run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/shared/stacks.ts src/shared/types.ts test/shared/stacks.test.ts
git commit -m "feat: stacks and the devcontainer template for repos without one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Stack detection

**Files:**
- Create: `src/server/stacks.ts`
- Test: `test/server/stacks.test.ts`

**Interfaces:**
- Consumes: `StackId` from `src/shared/stacks.ts` (Task 1).
- Produces: `detectStack(dir: string): Promise<StackId>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/server/stacks.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectStack } from "../../src/server/stacks";

let dir: string;
const touch = (...names: string[]) => names.forEach((n) => fs.writeFileSync(path.join(dir, n), ""));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-stack-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("detectStack", () => {
  it.each([
    [["package.json"], "node"],
    [["pyproject.toml"], "python"],
    [["requirements.txt"], "python"],
    [["setup.py"], "python"],
    [["go.mod"], "go"],
    [["Cargo.toml"], "rust"],
    [["Gemfile"], "ruby"],
    [["pom.xml"], "java"],
    [["build.gradle.kts"], "java"],
    [["App.csproj"], "dotnet"],
    [["Solution.sln"], "dotnet"],
    [["composer.json"], "php"],
    [["README.md"], "generic"],
  ])("%j → %s", async (files, stack) => {
    touch(...files);
    expect(await detectStack(dir)).toBe(stack);
  });

  it("takes the first stack in table order when several match", async () => {
    touch("pyproject.toml", "package.json", "go.mod");
    expect(await detectStack(dir)).toBe("node");
  });

  it("ignores markers in subfolders and folders named like markers", async () => {
    fs.mkdirSync(path.join(dir, "web"));
    fs.writeFileSync(path.join(dir, "web", "package.json"), "");
    fs.mkdirSync(path.join(dir, "go.mod"));
    expect(await detectStack(dir)).toBe("generic");
  });

  it("falls back to generic for an unreadable folder", async () => {
    expect(await detectStack(path.join(dir, "missing"))).toBe("generic");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/server/stacks.test.ts`
Expected: FAIL, because `src/server/stacks.ts` can't be resolved.

- [ ] **Step 3: Implement**

```ts
// src/server/stacks.ts
import fs from "node:fs/promises";
import type { StackId } from "../shared/stacks";

/** Top-level files that identify a stack; the first stack with a match wins. */
const MARKERS: [StackId, (name: string) => boolean][] = [
  ["node", (n) => n === "package.json"],
  ["python", (n) => n === "pyproject.toml" || n === "requirements.txt" || n === "setup.py"],
  ["go", (n) => n === "go.mod"],
  ["rust", (n) => n === "Cargo.toml"],
  ["ruby", (n) => n === "Gemfile"],
  ["java", (n) => n === "pom.xml" || n === "build.gradle" || n === "build.gradle.kts"],
  ["dotnet", (n) => n.endsWith(".csproj") || n.endsWith(".sln")],
  ["php", (n) => n === "composer.json"],
];

export async function detectStack(dir: string): Promise<StackId> {
  let files: string[];
  try {
    files = (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return "generic";
  }
  return MARKERS.find(([, match]) => files.some(match))?.[0] ?? "generic";
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/server/stacks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/stacks.ts test/server/stacks.test.ts
git commit -m "feat: detect a repo's stack from its top-level files

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `scanCandidates` in discovery

**Files:**
- Modify: `src/server/discovery.ts`
- Test: `test/server/discovery.test.ts`

**Interfaces:**
- Consumes: `detectStack` (Task 2), `Candidate` (Task 1).
- Produces: `scanCandidates(roots: string[], maxDepth = 2, onWarn?: (msg: string) => void): Promise<Candidate[]>`. `scanRoots` keeps its signature and behaviour.

- [ ] **Step 1: Write the failing tests**

Add `scanCandidates` to the import in `test/server/discovery.test.ts` and add a `git` helper next to `mk`:

```ts
import { scanCandidates, scanRoots } from "../../src/server/discovery";

/** A git repo: a .git folder, or a .git file as in submodules and linked worktrees. */
function git(rel: string, asFile = false) {
  const dir = path.join(root, rel);
  fs.mkdirSync(dir, { recursive: true });
  if (asFile) fs.writeFileSync(path.join(dir, ".git"), "gitdir: /elsewhere\n");
  else fs.mkdirSync(path.join(dir, ".git"));
}
```

Append:

```ts
describe("scanCandidates", () => {
  it("lists git repos without a devcontainer at depth 1 and 2, with their root and stack", async () => {
    git("app");
    fs.writeFileSync(path.join(root, "app", "package.json"), "{}");
    git("org/svc", true);
    const found = await scanCandidates([root]);
    expect(found).toEqual([
      { path: path.join(root, "app"), name: "app", root, stack: "node" },
      { path: path.join(root, "org/svc"), name: "svc", root, stack: "generic" },
    ]);
  });

  it("skips projects and everything inside them", async () => {
    git("proj");
    mk("proj/.devcontainer", "devcontainer.json");
    git("proj/vendored-submodule");
    git("other");
    mk("other", ".devcontainer.json");
    expect(await scanCandidates([root])).toEqual([]);
  });

  it("does not descend into a candidate", async () => {
    git("mono");
    git("mono/nested");
    expect((await scanCandidates([root])).map((c) => c.name)).toEqual(["mono"]);
  });

  it("skips depth 3, node_modules, hidden dirs and worktree folders", async () => {
    git("org/deep/c");
    git("node_modules/x");
    git(".hidden/y");
    git("a.worktrees/feature");
    mk("plain/folder");
    expect(await scanCandidates([root])).toEqual([]);
  });

  it("dedupes overlapping roots and keeps the first root a repo was found under", async () => {
    git("org/b");
    const found = await scanCandidates([root, path.join(root, "org")]);
    expect(found).toEqual([{ path: path.join(root, "org/b"), name: "b", root, stack: "generic" }]);
  });

  it("warns once for a missing root", async () => {
    git("a");
    const warn = vi.fn();
    expect((await scanCandidates([path.join(root, "nope"), root], 2, warn)).map((c) => c.name)).toEqual(["a"]);
    expect(warn).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server/discovery.test.ts`
Expected: FAIL, because `scanCandidates` isn't exported. The existing `scanRoots` tests still pass.

- [ ] **Step 3: Implement**

Replace the body of `src/server/discovery.ts` after `findDevcontainerSpec` with a shared walk. `scanRoots` keeps its behaviour, including the existing tests.

```ts
import type { Candidate, Project } from "../shared/types";
import { detectStack } from "./stacks";

async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Visits folders under each root up to `maxDepth`, skipping dotfolders, node_modules and
 * worktree folders. `claim` returns true when it has taken a folder, so the walk doesn't go
 * inside it.
 */
async function walk(
  roots: string[],
  maxDepth: number,
  onWarn: (msg: string) => void,
  claim: (dir: string, root: string) => Promise<boolean>,
): Promise<void> {
  async function visit(dir: string, root: string, depth: number): Promise<void> {
    if (await claim(dir, root)) return;
    if (depth >= maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (depth === 0) onWarn(`opendevhub: cannot read root ${dir}: ${(err as Error).message}`);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      // Worktrees opendevhub keeps next to a project carry its devcontainer.json too; they aren't projects.
      if (entry.name.endsWith(WORKTREES_SUFFIX)) continue;
      await visit(path.join(dir, entry.name), root, depth + 1);
    }
  }
  for (const root of roots) {
    const resolved = path.resolve(root);
    await visit(resolved, resolved, 0);
  }
}

export async function scanRoots(
  roots: string[],
  maxDepth = 2,
  onWarn: (msg: string) => void = (m) => console.warn(m),
): Promise<Project[]> {
  const found = new Map<string, Project>();
  await walk(roots, maxDepth, onWarn, async (dir) => {
    if (found.has(dir)) return true;
    const spec = await findDevcontainerSpec(dir);
    if (!spec) return false;
    found.set(dir, { id: projectId(dir), name: path.basename(dir), path: dir, devcontainerPath: spec });
    return true;
  });
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

/** Git repos under the roots that have no devcontainer: what Add project offers. */
export async function scanCandidates(
  roots: string[],
  maxDepth = 2,
  onWarn: (msg: string) => void = (m) => console.warn(m),
): Promise<Candidate[]> {
  const found = new Map<string, Candidate>();
  const projects = new Set<string>();
  await walk(roots, maxDepth, onWarn, async (dir, root) => {
    if (found.has(dir) || projects.has(dir)) return true;
    if (await findDevcontainerSpec(dir)) {
      projects.add(dir);
      return true;
    }
    if (!(await isGitRepo(dir))) return false;
    found.set(dir, { path: dir, name: path.basename(dir), root, stack: await detectStack(dir) });
    return true;
  });
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}
```

The old `scanRoots` body (the inner `visit` and its loop) is removed. Keep the `Dirent` import.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/server/discovery.test.ts`
Expected: PASS, for both the old `scanRoots` tests and the new ones.

- [ ] **Step 5: Commit**

```bash
git add src/server/discovery.ts test/server/discovery.test.ts
git commit -m "feat: scanCandidates lists git repos under the roots without a devcontainer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Onboarding module (validate and write)

**Files:**
- Create: `src/server/onboarding.ts`
- Test: `test/server/onboarding.test.ts`

**Interfaces:**
- Consumes: `scanCandidates` (Task 3), `isStackId` and `renderDevcontainer` (Task 1), `InvalidRequestError` from `src/server/worktrees.ts`, `NotFoundError` from `src/server/orchestrator.ts`.
- Produces:
  - `class DevcontainerExistsError extends Error` (mapped to 409 in Task 5)
  - `interface OnboardingDeps { roots: () => string[]; scan?: (roots: string[]) => Promise<Candidate[]> }`
  - `class Onboarding { constructor(deps: OnboardingDeps); list(): Promise<CandidateList>; add(repoPath: string, stack: unknown): Promise<Candidate> }`
  - `type OnboardingPort = Pick<Onboarding, "list" | "add">`

- [ ] **Step 1: Write the failing test**

```ts
// test/server/onboarding.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DevcontainerExistsError, Onboarding } from "../../src/server/onboarding";
import { NotFoundError } from "../../src/server/orchestrator";
import { InvalidRequestError } from "../../src/server/worktrees";
import { renderDevcontainer } from "../../src/shared/stacks";

let root: string;
let onboarding: Onboarding;
const repo = (rel: string) => {
  fs.mkdirSync(path.join(root, rel, ".git"), { recursive: true });
  return path.join(root, rel);
};
const spec = (dir: string) => path.join(dir, ".devcontainer", "devcontainer.json");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "odh-onboard-"));
  onboarding = new Onboarding({ roots: () => [root] });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("Onboarding", () => {
  it("lists the roots and candidates", async () => {
    const app = repo("app");
    expect(await onboarding.list()).toEqual({
      roots: [root],
      candidates: [{ path: app, name: "app", root, stack: "generic" }],
    });
  });

  it("writes the template for the chosen stack and returns the candidate", async () => {
    const app = repo("app");
    const added = await onboarding.add(app, "rust");
    expect(added.path).toBe(app);
    expect(fs.readFileSync(spec(app), "utf8")).toBe(renderDevcontainer("app", "rust"));
  });

  it("rejects an unknown stack before touching the disk", async () => {
    const app = repo("app");
    await expect(onboarding.add(app, "cobol")).rejects.toBeInstanceOf(InvalidRequestError);
    await expect(onboarding.add(app, undefined)).rejects.toBeInstanceOf(InvalidRequestError);
    expect(fs.existsSync(path.join(app, ".devcontainer"))).toBe(false);
  });

  it.each([
    ["a path outside the roots", () => path.join(os.tmpdir(), "elsewhere")],
    // String concatenation on purpose: path.join would normalise the .. away.
    ["a path with ..", () => `${root}/app/../app`],
    ["a trailing slash", () => `${path.join(root, "app")}/`],
    ["a relative path", () => "app"],
    ["a plain folder", () => (fs.mkdirSync(path.join(root, "plain")), path.join(root, "plain"))],
    ["a repo below maxDepth", () => repo("a/b/c")],
    ["an empty path", () => ""],
  ])("refuses %s with NotFoundError and writes nothing", async (_what, target) => {
    repo("app");
    const p = target();
    await expect(onboarding.add(p, "node")).rejects.toBeInstanceOf(NotFoundError);
    expect(fs.existsSync(spec(path.join(root, "app")))).toBe(false);
  });

  it("refuses a repo that became a project since it was listed", async () => {
    const app = repo("app");
    fs.writeFileSync(path.join(app, ".devcontainer.json"), "{}");
    await expect(onboarding.add(app, "node")).rejects.toBeInstanceOf(NotFoundError);
    expect(fs.existsSync(spec(app))).toBe(false);
  });

  it("never overwrites a file that appears after the scan", async () => {
    const app = repo("app");
    const racing = new Onboarding({
      roots: () => [root],
      // The scan still sees a candidate, then another writer creates the file.
      scan: async () => {
        const found = [{ path: app, name: "app", root, stack: "node" as const }];
        fs.mkdirSync(path.join(app, ".devcontainer"));
        fs.writeFileSync(spec(app), "mine");
        return found;
      },
    });
    await expect(racing.add(app, "node")).rejects.toBeInstanceOf(DevcontainerExistsError);
    expect(fs.readFileSync(spec(app), "utf8")).toBe("mine");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/server/onboarding.test.ts`
Expected: FAIL, because `src/server/onboarding.ts` can't be resolved.

- [ ] **Step 3: Implement**

```ts
// src/server/onboarding.ts
import fs from "node:fs/promises";
import path from "node:path";
import { isStackId, renderDevcontainer } from "../shared/stacks";
import type { Candidate, CandidateList } from "../shared/types";
import { scanCandidates } from "./discovery";
import { NotFoundError } from "./orchestrator";
import { InvalidRequestError } from "./worktrees";

export class DevcontainerExistsError extends Error {
  constructor(dir: string) {
    super(`${dir} already has a devcontainer.json`);
    this.name = "DevcontainerExistsError";
  }
}

export interface OnboardingDeps {
  roots: () => string[];
  /** Defaults to scanning the disk; tests pass their own. */
  scan?: (roots: string[]) => Promise<Candidate[]>;
}

/** Add project: lists repos without a devcontainer and writes one into a repo the user picks. */
export class Onboarding {
  constructor(private readonly deps: OnboardingDeps) {}

  private scan(): Promise<Candidate[]> {
    return (this.deps.scan ?? ((roots) => scanCandidates(roots)))(this.deps.roots());
  }

  async list(): Promise<CandidateList> {
    return { roots: this.deps.roots(), candidates: await this.scan() };
  }

  /**
   * Writes `.devcontainer/devcontainer.json` into `repoPath`, which must be exactly one of the
   * candidates right now: that keeps writes under a root, in a git repo without a devcontainer.
   */
  async add(repoPath: string, stack: unknown): Promise<Candidate> {
    if (!isStackId(stack)) throw new InvalidRequestError(`unknown stack ${String(stack)}`);
    const candidate = (await this.scan()).find((c) => c.path === repoPath);
    if (!candidate) throw new NotFoundError(repoPath || "(empty path)", "repo without a devcontainer");
    const dir = path.join(candidate.path, ".devcontainer");
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.writeFile(path.join(dir, "devcontainer.json"), renderDevcontainer(candidate.name, stack), { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new DevcontainerExistsError(candidate.path);
      throw err;
    }
    return candidate;
  }
}

export type OnboardingPort = Pick<Onboarding, "list" | "add">;
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/server/onboarding.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/onboarding.ts test/server/onboarding.test.ts
git commit -m "feat: onboarding writes a devcontainer into a repo only when it is a fresh candidate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Dashboard routes and wiring

**Files:**
- Modify: `src/server/dashboard-api.ts` (`DashboardDeps`, `errorStatus`, new routes after the rescan route)
- Modify: `src/server/cli.ts:166` (construct `Onboarding`)
- Test: `test/server/dashboard-api.test.ts`

**Interfaces:**
- Consumes: `OnboardingPort` and `DevcontainerExistsError` (Task 4), `AddProjectResult` and `CandidateList` (Task 1), `store.projects()`, `store.preflight()`, `orchestrator.rescan()`, `orchestrator.start(id)`.
- Produces: `GET /api/onboarding/candidates` returns `CandidateList`. `POST /api/onboarding` with body `{ path: string, stack: StackId }` returns `AddProjectResult` (200) or `{ error }` with 400, 404, 409 or 500.

- [ ] **Step 1: Write the failing tests**

In `test/server/dashboard-api.test.ts`, give `setup` an onboarding fake and pass it to the app:

```ts
import { DevcontainerExistsError, type OnboardingPort } from "../../src/server/onboarding";
import type { Candidate } from "../../src/shared/types";

const added: Candidate = { path: "/src/new-app", name: "new-app", root: "/src", stack: "node" };
const newProject: Project = { id: "new-app-def456", name: "new-app", path: "/src/new-app", devcontainerPath: "/src/new-app/.devcontainer/devcontainer.json" };

// inside setup(), before the return:
const onboarding = {
  list: vi.fn(async () => ({ roots: ["/src"], candidates: [added] })),
  add: vi.fn(async (_path: string, _stack: unknown) => added),
} satisfies OnboardingPort;
// Rescanning after a write discovers the new project.
orchestrator.rescan.mockImplementation(async () => store.setProjects([project, newProject]));
return { store, orchestrator, onboarding, app: createDashboardApp({ store, orchestrator, onboarding, webDir }) };
```

Add the tests:

```ts
describe("add project", () => {
  const post = (app: ReturnType<typeof setup>["app"], body: unknown) =>
    app.request("/api/onboarding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("GET candidates returns the onboarding list", async () => {
    const { app } = setup();
    expect(await (await app.request("/api/onboarding/candidates")).json()).toEqual({ roots: ["/src"], candidates: [added] });
  });

  it("writes, rescans, starts the new project and returns its id", async () => {
    const { app, onboarding, orchestrator } = setup();
    const res = await post(app, { path: "/src/new-app", stack: "node" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projectId: newProject.id, started: true });
    expect(onboarding.add).toHaveBeenCalledWith("/src/new-app", "node");
    expect(orchestrator.rescan).toHaveBeenCalled();
    expect(orchestrator.start).toHaveBeenCalledWith(newProject.id);
  });

  it("writes but does not start while preflight has errors", async () => {
    const { app, store, orchestrator } = setup();
    store.setPreflight({ errors: ["docker not found"] });
    const res = await post(app, { path: "/src/new-app", stack: "node" });
    expect(await res.json()).toEqual({ projectId: newProject.id, started: false, error: "docker not found" });
    expect(orchestrator.start).not.toHaveBeenCalled();
  });

  it.each([
    [new InvalidRequestError("unknown stack x"), 400],
    [new NotFoundError("/etc", "repo without a devcontainer"), 404],
    [new DevcontainerExistsError("/src/new-app"), 409],
    [new Error("EACCES: permission denied"), 500],
  ])("maps %s to %i without rescanning", async (err, status) => {
    const { app, onboarding, orchestrator } = setup();
    onboarding.add.mockRejectedValueOnce(err);
    const res = await post(app, { path: "/src/new-app", stack: "node" });
    expect(res.status).toBe(status);
    expect((await res.json()).error).toBe(err.message);
    expect(orchestrator.rescan).not.toHaveBeenCalled();
  });

  it("passes a missing path through as an empty string", async () => {
    const { app, onboarding } = setup();
    await post(app, { stack: "node" });
    expect(onboarding.add).toHaveBeenCalledWith("", "node");
  });

  it("blocks a cross-site POST", async () => {
    const { app, onboarding } = setup();
    const res = await app.request("/api/onboarding", {
      method: "POST",
      headers: { origin: "http://evil.example", host: "localhost:7777", "content-type": "application/json" },
      body: JSON.stringify({ path: "/src/new-app", stack: "node" }),
    });
    expect(res.status).toBe(403);
    expect(onboarding.add).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/server/dashboard-api.test.ts`
Expected: FAIL. `onboarding` is not a known `DashboardDeps` field, and the routes return 404.

- [ ] **Step 3: Implement**

In `src/server/dashboard-api.ts`:

```ts
import type { AddProjectResult, LogEvent } from "../shared/types";
import { DevcontainerExistsError, type OnboardingPort } from "./onboarding";

export interface DashboardDeps {
  store: StateStore;
  orchestrator: DashboardOrchestrator;
  onboarding: OnboardingPort;
  webDir?: string;
}
```

In `errorStatus`, map the new error:

```ts
  if (err instanceof BusyError || err instanceof AlreadyAnsweredError || err instanceof DevcontainerExistsError) return 409;
```

Destructure `onboarding` in `createDashboardApp` (`const { store, orchestrator, onboarding } = deps;`). Move the `json` helper so it is defined before the rescan route. It doesn't depend on anything defined after it. Then add after the rescan route:

```ts
  // Add project: repos under the roots without a devcontainer.
  app.get("/api/onboarding/candidates", async (c) => c.json(await onboarding.list()));
  app.post("/api/onboarding", (c) =>
    json(c, async (_id, b): Promise<AddProjectResult> => {
      const added = await onboarding.add(str(b.path) ?? "", b.stack);
      await orchestrator.rescan();
      const project = store.projects().find((p) => p.path === added.path);
      if (!project) throw new Error(`${added.path} was not discovered after writing its devcontainer.json`);
      const errors = store.preflight().errors;
      if (errors.length > 0) return { projectId: project.id, started: false, error: errors.join("; ") };
      orchestrator.start(project.id).catch(() => {});
      return { projectId: project.id, started: true };
    }),
  );
```

In `src/server/cli.ts`, import `Onboarding` and wire it in:

```ts
import { Onboarding } from "./onboarding";
// …
  const app = createDashboardApp({
    store,
    orchestrator,
    onboarding: new Onboarding({ roots: () => config.roots }),
    webDir: findWebDir(),
  });
```

Run `npm run typecheck`. If any other caller of `createDashboardApp` fails to compile (for example in `test/e2e/*.e2e.ts`), pass `onboarding: new Onboarding({ roots: () => [] })` there.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run test/server && npm run typecheck`
Expected: PASS, and no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/dashboard-api.ts src/server/cli.ts test/server/dashboard-api.test.ts
git commit -m "feat: routes to list repos without a devcontainer and add one as a project

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Web: Add project dialog, sidebar + and ⌘K entry

**Files:**
- Create: `src/web/onboarding.ts` (pure helpers)
- Create: `src/web/components/AddProjectDialog.tsx`
- Modify: `src/web/api.ts` (`fetchCandidates`, `addProject`)
- Modify: `src/web/DashboardContext.tsx` (`addProjectOpen`, `openAddProject`, `closeAddProject`)
- Modify: `src/web/layout/Shell.tsx` (mount the dialog, the + action, keep `n` from firing while it is open)
- Modify: `src/web/components/CommandPalette.tsx` ("Add project…")
- Test: `test/web/onboarding.test.ts`

**Interfaces:**
- Consumes: `STACKS`, `STACK_IDS`, `renderDevcontainer` and `StackId` (Task 1); `Candidate`, `CandidateList` and `AddProjectResult` (Task 1); the routes from Task 5.
- Produces: `fetchCandidates(): Promise<CandidateList>`, `addProject(path: string, stack: StackId): Promise<AddProjectResult>`, `candidateLabel(c: Candidate): string`, `addedDestination(r: AddProjectResult): string`.

- [ ] **Step 1: Write the failing test for the pure helpers**

```ts
// test/web/onboarding.test.ts
import { describe, expect, it } from "vitest";
import { addedDestination, candidateLabel } from "../../src/web/onboarding";

describe("candidateLabel", () => {
  it("shows the path relative to the root", () => {
    expect(candidateLabel({ path: "/home/u/code/org/app", name: "app", root: "/home/u/code", stack: "node" })).toBe("org/app");
  });
  it("shows the folder name when the root itself is the repo", () => {
    expect(candidateLabel({ path: "/home/u/code", name: "code", root: "/home/u/code", stack: "node" })).toBe("code");
  });
});

describe("addedDestination", () => {
  it("links to the project page", () => {
    expect(addedDestination({ projectId: "my app-abc123", started: true })).toBe("/p/my%20app-abc123");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/web/onboarding.test.ts`
Expected: FAIL, because `src/web/onboarding.ts` can't be resolved.

- [ ] **Step 3: Implement the helpers and API calls**

```ts
// src/web/onboarding.ts
import type { AddProjectResult, Candidate } from "../shared/types";

/** Where the repo sits under its root, as listed in Add project. */
export function candidateLabel(c: Candidate): string {
  if (c.path === c.root) return c.name;
  return c.path.startsWith(`${c.root}/`) ? c.path.slice(c.root.length + 1) : c.path;
}

export function addedDestination(r: AddProjectResult): string {
  return `/p/${encodeURIComponent(r.projectId)}`;
}
```

Add to `src/web/api.ts` (and add `AddProjectResult` and `CandidateList` to the type import, plus `import type { StackId } from "../shared/stacks";`):

```ts
export async function fetchCandidates(): Promise<CandidateList> {
  const res = await fetch("/api/onboarding/candidates");
  if (!res.ok) throw await failure(res, "list repos");
  return (await res.json()) as CandidateList;
}

export async function addProject(path: string, stack: StackId): Promise<AddProjectResult> {
  const res = await fetch("/api/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, stack }),
  });
  if (!res.ok) throw await failure(res, "add project");
  return (await res.json()) as AddProjectResult;
}
```

Run: `npx vitest run test/web/onboarding.test.ts`
Expected: PASS.

- [ ] **Step 4: Context state**

In `src/web/DashboardContext.tsx`, add to `DashboardContextValue`:

```ts
  /** Whether the Add project dialog is open. */
  addProjectOpen: boolean;
  openAddProject: () => void;
  closeAddProject: () => void;
```

In `DashboardProvider`: `const [addProjectOpen, setAddProjectOpen] = useState(false);`. In the `useMemo` value, add `addProjectOpen`, `openAddProject: () => setAddProjectOpen(true)` and `closeAddProject: () => setAddProjectOpen(false)`, and add `addProjectOpen` to the dependency array.

- [ ] **Step 5: The dialog**

```tsx
// src/web/components/AddProjectDialog.tsx
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { PlayIcon } from "lucide-react";
import { renderDevcontainer, STACK_IDS, STACKS, type StackId } from "../../shared/stacks";
import type { Candidate, CandidateList } from "../../shared/types";
import { addProject, fetchCandidates } from "../api";
import { useDash } from "../DashboardContext";
import { addedDestination, candidateLabel } from "../onboarding";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Choice } from "./Choice";

export function AddProjectDialog() {
  const { addProjectOpen, closeAddProject } = useDash();
  // Mounted per opening, so it always lists fresh candidates.
  return addProjectOpen ? <AddProjectForm onClose={closeAddProject} /> : null;
}

function AddProjectForm({ onClose }: { onClose: () => void }) {
  const { report } = useDash();
  const navigate = useNavigate();
  const [list, setList] = useState<CandidateList>();
  const [picked, setPicked] = useState<Candidate>();
  const [stack, setStack] = useState<StackId>("generic");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    fetchCandidates().then(
      (l) => live && setList(l),
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, []);

  const pick = (c: Candidate) => {
    setPicked(c);
    setStack(c.stack);
    setError(undefined);
  };

  const submit = () => {
    if (!picked || busy) return;
    setBusy(true);
    setError(undefined);
    addProject(picked.path, stack)
      .then(
        (result) => {
          onClose();
          void navigate(addedDestination(result));
          if (!result.started) report(new Error(`Added ${picked.name}, but it wasn't started: ${result.error ?? "unknown reason"}`));
        },
        (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Pick a git repo under your roots that has no devcontainer. opendevhub writes one that installs opencode.
          </DialogDescription>
        </DialogHeader>

        {!picked ? (
          <Command className="rounded-md border">
            <CommandInput placeholder="Filter repos" />
            <CommandList className="max-h-72">
              {!list && !error && (
                <div className="grid gap-2 p-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-8" />
                  ))}
                </div>
              )}
              {list && list.candidates.length === 0 && (
                <div className="p-3 text-sm text-muted-foreground">
                  No git repos without a devcontainer under {list.roots.join(", ")}
                </div>
              )}
              {list && list.candidates.length > 0 && <CommandEmpty>No match</CommandEmpty>}
              {list?.candidates.map((c) => (
                <CommandItem key={c.path} value={`${c.name} ${c.path}`} onSelect={() => pick(c)}>
                  <span className="font-medium">{c.name}</span>
                  <span className="truncate text-muted-foreground">{candidateLabel(c)}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{picked.name}</div>
                <div className="truncate text-muted-foreground">{picked.path}</div>
              </div>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setPicked(undefined)}>
                Change
              </Button>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="add-project-stack">Base image</Label>
              <Choice
                id="add-project-stack"
                size="default"
                className="w-full"
                value={stack}
                options={STACK_IDS.map((id) => ({ value: id, label: STACKS[id].label, title: STACKS[id].image }))}
                onChange={(v) => setStack(v as StackId)}
              />
              <p className="text-xs text-muted-foreground">Detected: {STACKS[picked.stack].label}</p>
            </div>
            <div className="grid gap-2">
              <Label>.devcontainer/devcontainer.json</Label>
              <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-xs">
                {renderDevcontainer(picked.name, stack)}
              </pre>
              <p className="text-xs text-muted-foreground">The file is left uncommitted.</p>
            </div>
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!picked || busy} onClick={submit}>
            <PlayIcon className="size-3" /> {busy ? "Adding…" : "Add and start"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6: The sidebar + and the shortcut guard**

In `src/web/layout/Shell.tsx`:

- Add `PlusIcon` to the lucide import, `SidebarGroupAction` to the sidebar import, and `import { AddProjectDialog } from "../components/AddProjectDialog";`.
- In `Shell`, read `addProjectOpen` from `useDash()`, change the `n` guard to `if (!palette && !newTaskFor && !addProjectOpen && opensNewTask(e))`, and add `addProjectOpen` to that effect's dependencies.
- Mount `<AddProjectDialog />` next to `<NewTaskDialog />`.
- In `AppSidebar`, read `openAddProject` from `useDash()` and replace the Projects group label with:

```tsx
          <SidebarGroupLabel className="justify-between pr-8">
            <span>Projects</span>
            <span>{snapshot.projects.length}</span>
          </SidebarGroupLabel>
          <SidebarGroupAction title="Add project" aria-label="Add project" onClick={openAddProject}>
            <PlusIcon />
          </SidebarGroupAction>
```

- [ ] **Step 7: ⌘K entry**

In `src/web/components/CommandPalette.tsx`, read `openAddProject` from `useDash()`. Add it after the rescan item and to the `useMemo` dependencies:

```ts
      { key: "act-add-project", group: "Actions", label: "Add project…", run: openAddProject },
```

- [ ] **Step 8: Typecheck, tests, build**

Run: `npm run typecheck && npx vitest run && npm run build`
Expected: all pass. The build writes `dist/` without errors.

- [ ] **Step 9: Check it in the real app**

Make a scratch root containing one bare repo: `mkdir -p $SCRATCH/root/hello && git -C $SCRATCH/root/hello init -q && touch $SCRATCH/root/hello/go.mod`. Run `npm run dev -- --root $SCRATCH/root --port 7788` (this adds a root to the saved config; remove it from `~/.config/opendevhub/config.json` afterwards). Open `http://localhost:7788`, click **+** next to Projects, and check:

- `hello` is listed.
- Picking it shows "Detected: Go" and the preview.
- Switching the image to Node.js updates the preview.
- **Add and start** takes you to the hello project page, which starts.

Also check that the `⌘K` "Add project…" entry opens the dialog, and that pressing `n` while the dialog is open doesn't open New task. Stop the hello project from the dashboard afterwards.

- [ ] **Step 10: Commit**

```bash
git add src/web test/web/onboarding.test.ts
git commit -m "feat(web): Add project dialog from the sidebar's + and ⌘K

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: e2e test and README

**Files:**
- Create: `test/e2e/add-project.e2e.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `Onboarding` (Task 4), `createDashboardApp` (Task 5), `scanRoots`, `Orchestrator` and the real ports, built the way `test/e2e/opendevhub.e2e.ts` builds them.

- [ ] **Step 1: Write the e2e test**

```ts
// test/e2e/add-project.e2e.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Containers } from "../../src/server/containers";
import { createDashboardApp } from "../../src/server/dashboard-api";
import { scanRoots } from "../../src/server/discovery";
import { EditorLauncher } from "../../src/server/editors";
import { spawnRunner } from "../../src/server/exec";
import { Gateway } from "../../src/server/gateway";
import { GitOps } from "../../src/server/git";
import { Network, parseRouteMode } from "../../src/server/network";
import { Onboarding } from "../../src/server/onboarding";
import { OpencodeClient } from "../../src/server/opencode/client";
import { OpencodeRuntime } from "../../src/server/opencode/runtime";
import { Orchestrator } from "../../src/server/orchestrator";
import { PortForwarder } from "../../src/server/port-forwarder";
import { Publisher } from "../../src/server/publish";
import { RelayRuntime } from "../../src/server/relay/runtime";
import { StateStore } from "../../src/server/state";
import { Worktrees } from "../../src/server/worktrees";

describe.skipIf(!process.env.OPENDEVHUB_E2E)("e2e: add a repo without a devcontainer", () => {
  it("lists it, writes the template, and the project starts with opencode", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "odh-e2e-add-"));
    const repo = path.join(root, "hello");
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", repo]);
    fs.writeFileSync(path.join(repo, "package.json"), "{}\n");

    const roots = () => [root];
    const store = new StateStore({ port: 0, persisted: { projects: {} }, persist: () => {} });
    const containers = new Containers(spawnRunner);
    const clientFor = (ep: { baseUrl: string; password: string }) => new OpencodeClient(ep);
    const orch = new Orchestrator({
      store,
      containers,
      runtime: new OpencodeRuntime({ containers, clientFor }),
      forwarder: new PortForwarder(),
      relay: new RelayRuntime({ containers }),
      network: new Network({ mode: parseRouteMode(process.env.OPENDEVHUB_ROUTE), gateway: new Gateway({ run: spawnRunner }) }),
      worktrees: new Worktrees({ containers, run: spawnRunner }),
      git: new GitOps({ containers }),
      publisher: new Publisher({ containers, run: spawnRunner, forges: { all: () => ({}), remember: () => {} } }),
      editors: new EditorLauncher([]),
      clientFor,
      roots,
      scan: (r) => scanRoots(r),
    });
    orch.onLog((_id, line) => console.log(`[e2e add] ${line}`));
    const app = createDashboardApp({ store, orchestrator: orch, onboarding: new Onboarding({ roots }) });

    let projectId = "";
    try {
      const list = await (await app.request("/api/onboarding/candidates")).json();
      expect(list.candidates).toEqual([{ path: repo, name: "hello", root, stack: "node" }]);

      const res = await app.request("/api/onboarding", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: repo, stack: "node" }),
      });
      expect(res.status).toBe(200);
      const result = await res.json();
      expect(result.started).toBe(true);
      projectId = result.projectId;
      expect(fs.existsSync(path.join(repo, ".devcontainer", "devcontainer.json"))).toBe(true);

      await vi.waitFor(
        () => expect(store.runtime(projectId)).toMatchObject({ containerState: "running", opencode: "healthy" }),
        { timeout: 15 * 60_000, interval: 2000 },
      );
    } finally {
      if (projectId) {
        await orch.stop(projectId).catch(() => {});
        const id = execFileSync("docker", ["ps", "-aq", "--filter", `label=devcontainer.local_folder=${repo}`]).toString().trim();
        if (id) execFileSync("docker", ["rm", "-f", ...id.split("\n")]);
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
```

The test assumes the `Orchestrator` constructor takes the same fields as in `test/e2e/opendevhub.e2e.ts`. If that file passes more required fields, copy them.

- [ ] **Step 2: Run the e2e test**

Run: `OPENDEVHUB_E2E=1 npx vitest run -c vitest.e2e.config.ts test/e2e/add-project.e2e.ts`
Expected: PASS. The first run pulls `javascript-node:22` and runs the opencode installer, which needs network access. If the installer fails because there is no network, report that; don't weaken the test.

- [ ] **Step 3: Update the README**

In `README.md`, change the first feature bullet to:

```markdown
- Discovers projects with a `.devcontainer/devcontainer.json` (or `.devcontainer.json`) under your roots (up to 2 levels deep). Git repos without one can be added with **Add project**.
```

In the Requirements section, change the opencode bullet's first words to "opencode v2 installed in each project's devcontainer (**Add project** sets this up for you), either with…". Then add a section before `## Publish`:

```markdown
## Add project

The **+** next to Projects in the sidebar (or **Add project…** in `⌘K`) lists the git repos under your roots that have no devcontainer. Pick one and opendevhub writes `.devcontainer/devcontainer.json` with a base image for its stack and the opencode installer as `postCreateCommand`, then starts the project. The file is left uncommitted, so you can change it, commit it or delete it.

| Found in the repo | Image (`mcr.microsoft.com/devcontainers/…`) |
| --- | --- |
| `package.json` | `javascript-node:22` |
| `pyproject.toml`, `requirements.txt`, `setup.py` | `python:3` |
| `go.mod` | `go:1` |
| `Cargo.toml` | `rust:1` |
| `Gemfile` | `ruby:3` |
| `pom.xml`, `build.gradle(.kts)` | `java:21` |
| `*.csproj`, `*.sln` | `dotnet:8.0` |
| `composer.json` | `php:8` |
| anything else | `base:ubuntu` |

The first match wins, and you can pick another image in the dialog.
```

Also remove the "Bootstrap repos that have no devcontainer" bullet from `docs/superpowers/backlog.md`'s High value list, and add "add project" to the "Specced so far" sentence at the top.

- [ ] **Step 4: Run the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/add-project.e2e.ts README.md docs/superpowers/backlog.md
git commit -m "test: e2e for adding a repo without a devcontainer; docs: Add project

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
