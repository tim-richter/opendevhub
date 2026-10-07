# Resource Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each running environment's current CPU and memory, from `docker stats`, on the Overview's project tiles (summed per project) and the project page's checkout cards.

**Architecture:** A sampler in the server (`src/server/resources.ts`) runs one `docker stats --no-stream` call every 5 s for all running environments and hands the rounded numbers to the `StateStore`, which adds `resources` (by environment id) to the snapshot it already streams over SSE. The web derives per-project sums and per-checkout numbers from the snapshot and shows them with one small component.

**Tech Stack:** TypeScript, Node (`docker` CLI through the `Runner` in `src/server/exec.ts`), Vitest, React with Tailwind and shadcn/ui.

**Spec:** `docs/superpowers/specs/2026-10-05-resource-stats-design.md`

## Global Constraints

- All paths below are relative to `apps/opendevhub/` unless they start with `docs/`. Run commands from `apps/opendevhub/`.
- Work on `main`, no worktree.
- `src/shared/types.ts` and `src/server/cli.ts` also hold the partner's uncommitted Usage-page work. Commit only this plan's changes: before Task 1, confirm that work has been committed; if it hasn't, stop and ask.
- CPU is percent of one core, as `docker stats` reports it (can exceed 100), rounded to a whole number. Memory is bytes rounded to 1 MiB.
- Poll every 5000 ms; the next round starts when the previous ends. `docker stats` timeout 15 s.
- Failures show nothing and log nothing.
- Display: `CPU 12% · 1.3 GiB`; memory in MiB below 1 GiB (`512 MiB`), GiB with one decimal from 1 GiB (`1.3 GiB`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A container stops between container refreshes** (state still says `running` for up to 10 s). `docker stats` then fails the whole call with `No such container: <id>`, so every tile would blank. Expected: the others keep their numbers. Pinned by the retry test in Task 1.
2. **A container stopping mid-sample** prints `--` or `0B / 0B`. Expected: that environment is left out, the rest shown. Pinned by `parseStats` tests in Task 1.
3. **Shutdown while a `docker stats` call is in flight.** Expected: no store write after `stop()`, no further rounds. Pinned in Task 3.
4. **A slow `docker stats` (longer than the interval).** Expected: rounds never overlap. Pinned in Task 3.
5. **A worktree sharing the main container.** Expected: its card shows nothing, so the main container's load isn't shown twice on the page. Pinned in Task 4.

---

### Task 1: Shared type and `docker stats` parsing

**Files:**

- Modify: `src/shared/types.ts` (next to `UsageReport`, and `DashboardSnapshot`)
- Create: `src/server/resources.ts`
- Test: `test/server/resources.test.ts`

**Interfaces:**

- Produces: `ResourceStats { cpu: number; memory: number; memoryLimit: number }` and `DashboardSnapshot.resources?: Record<EnvId, ResourceStats>` in `src/shared/types.ts`; `parseStats(stdout: string): Map<string, ResourceStats>`, `RunningContainer { envId: EnvId; containerId: string }`, `sampleResources(run: Runner, running: RunningContainer[]): Promise<Record<EnvId, ResourceStats>>` in `src/server/resources.ts`.

- [ ] **Step 1: Add the shared type**

In `src/shared/types.ts`, before `export interface DashboardSnapshot`:

```ts
/** One container's load, as `docker stats` reports it. */
export interface ResourceStats {
  /** Percent of one CPU core, so it exceeds 100 on several cores (as in `docker stats`). Whole number. */
  cpu: number;
  /** Bytes, rounded to 1 MiB. */
  memory: number;
  /** Bytes; the container's limit, or the host's memory when it has none. */
  memoryLimit: number;
}
```

and inside `DashboardSnapshot`, after `usage?`:

```ts
  /** By environment id (a main environment's id is its project id); running environments only. */
  resources?: Record<EnvId, ResourceStats>;
```

- [ ] **Step 2: Write the failing tests**

`test/server/resources.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { parseStats, sampleResources } from "../../src/server/resources";
import { fakeRunner } from "../helpers/fake-runner";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const line = (id: string, cpu: string, mem: string) =>
  JSON.stringify({ ID: id, CPUPerc: cpu, MemUsage: mem, Name: "x" });
const FULL_A = "aaaaaaaaaaaa" + "0".repeat(52);
const FULL_B = "bbbbbbbbbbbb" + "0".repeat(52);

describe("parseStats", () => {
  it("reads CPU and memory with binary units, rounded", () => {
    const stats = parseStats(
      `${line("aaaaaaaaaaaa", "12.6%", "1.248GiB / 31.24GiB")}\n`
    );
    expect(stats.get("aaaaaaaaaaaa")).toEqual({
      cpu: 13,
      memory: Math.round((1.248 * GiB) / MiB) * MiB,
      memoryLimit: Math.round((31.24 * GiB) / MiB) * MiB,
    });
  });

  it("accepts B, KiB, MiB, TiB and decimal kB/MB/GB", () => {
    const out = parseStats(
      [
        line("a", "0.00%", "512KiB / 2MiB"),
        line("b", "150.2%", "700MB / 1TiB"),
        line("c", "1%", "3000000kB / 4GB"),
        line("d", "1%", "1048576B / 8GiB"),
      ].join("\n")
    );
    expect(out.get("a")).toEqual({
      cpu: 0,
      memory: 1 * MiB,
      memoryLimit: 2 * MiB,
    });
    expect(out.get("b")).toEqual({
      cpu: 150,
      memory: Math.round(700e6 / MiB) * MiB,
      memoryLimit: 1024 ** 4,
    });
    expect(out.get("c")?.memory).toBe(Math.round(3e9 / MiB) * MiB);
    expect(out.get("d")?.memory).toBe(MiB);
  });

  it("skips stopping containers and lines that don't parse", () => {
    const out = parseStats(
      [
        line("a", "--", "-- / --"),
        line("b", "1%", "0B / 0B"),
        line("c", "", "1MiB / 2MiB"),
        "not json",
        "{broken",
        JSON.stringify({ ID: "", CPUPerc: "1%", MemUsage: "1MiB / 2MiB" }),
        line("ok", "2%", "1MiB / 2MiB"),
      ].join("\n")
    );
    expect([...out.keys()]).toEqual(["ok"]);
  });
});

describe("sampleResources", () => {
  it("makes no docker call when nothing runs", async () => {
    const { run, calls } = fakeRunner();
    expect(await sampleResources(run, [])).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("asks docker for all containers at once and matches short ids to environments", async () => {
    const { run, calls } = fakeRunner(() => ({
      stdout: `${line("aaaaaaaaaaaa", "5%", "1GiB / 2GiB")}\n${line("bbbbbbbbbbbb", "7%", "1MiB / 2GiB")}\n`,
    }));
    const out = await sampleResources(run, [
      { envId: "proj", containerId: FULL_A },
      { envId: "env-1", containerId: FULL_B },
    ]);
    expect(calls[0].cmd).toBe("docker");
    expect(calls[0].args).toEqual([
      "stats",
      "--no-stream",
      "--format",
      "{{json .}}",
      FULL_A,
      FULL_B,
    ]);
    expect(calls[0].opts?.timeoutMs).toBe(15_000);
    expect(out).toEqual({
      proj: { cpu: 5, memory: GiB, memoryLimit: 2 * GiB },
      "env-1": { cpu: 7, memory: MiB, memoryLimit: 2 * GiB },
    });
  });

  it("retries once without a container that is gone", async () => {
    const { run, calls } = fakeRunner((c) =>
      c.args.includes(FULL_B)
        ? {
            exitCode: 1,
            stderr: "Error response from daemon: No such container: " + FULL_B,
          }
        : { stdout: line("aaaaaaaaaaaa", "5%", "1GiB / 2GiB") }
    );
    const out = await sampleResources(run, [
      { envId: "proj", containerId: FULL_A },
      { envId: "env-1", containerId: FULL_B },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1].args.slice(4)).toEqual([FULL_A]);
    expect(Object.keys(out)).toEqual(["proj"]);
  });

  it("returns nothing when docker fails for another reason or times out", async () => {
    const failing = fakeRunner(() => ({
      exitCode: 1,
      stderr: "Cannot connect to the Docker daemon",
    }));
    expect(
      await sampleResources(failing.run, [{ envId: "p", containerId: FULL_A }])
    ).toEqual({});
    expect(failing.calls).toHaveLength(1);
    const slow = fakeRunner(() => ({ exitCode: 1, timedOut: true }));
    expect(
      await sampleResources(slow.run, [{ envId: "p", containerId: FULL_A }])
    ).toEqual({});
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run test/server/resources.test.ts` Expected: FAIL, cannot resolve `../../src/server/resources`.

- [ ] **Step 4: Implement**

`src/server/resources.ts`:

```ts
import type { EnvId, ResourceStats } from "../shared/types";
import type { Runner } from "./exec";

const STATS_TIMEOUT_MS = 15_000;
const MiB = 1024 ** 2;

const UNITS: Record<string, number> = {
  b: 1,
  kib: 1024,
  mib: MiB,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
  kb: 1e3,
  mb: 1e6,
  gb: 1e9,
  tb: 1e12,
};

/** `"1.248GiB"` in bytes; docker uses binary units for memory, and decimal ones on some platforms. */
function parseSize(text: string): number | undefined {
  const m = /^([\d.]+)\s*([a-z]*)$/i.exec(text.trim());
  if (!m) return undefined;
  const unit = UNITS[(m[2] || "b").toLowerCase()];
  const n = Number(m[1]);
  return unit !== undefined && Number.isFinite(n) ? n * unit : undefined;
}

const roundMiB = (bytes: number) => Math.round(bytes / MiB) * MiB;

/** `docker stats --format '{{json .}}'` output by the short id docker prints; containers mid-stop are left out. */
export function parseStats(stdout: string): Map<string, ResourceStats> {
  const out = new Map<string, ResourceStats>();
  for (const raw of stdout.split(/\r?\n/)) {
    const text = raw.trim();
    if (!text.startsWith("{")) continue;
    let row: { ID?: unknown; CPUPerc?: unknown; MemUsage?: unknown };
    try {
      row = JSON.parse(text) as typeof row;
    } catch {
      continue;
    }
    if (
      typeof row.ID !== "string" ||
      row.ID === "" ||
      typeof row.CPUPerc !== "string" ||
      typeof row.MemUsage !== "string"
    ) {
      continue;
    }
    const cpu = /^([\d.]+)%$/.exec(row.CPUPerc.trim());
    const [used, limit] = row.MemUsage.split("/").map(parseSize);
    if (!cpu || used === undefined || !limit) continue;
    out.set(row.ID, {
      cpu: Math.round(Number(cpu[1])),
      memory: roundMiB(used),
      memoryLimit: roundMiB(limit),
    });
  }
  return out;
}

export interface RunningContainer {
  envId: EnvId;
  containerId: string;
}

const sameContainer = (a: string, b: string) =>
  a.startsWith(b) || b.startsWith(a);

/** Every running environment's load from one `docker stats` call; nothing when docker fails. */
export async function sampleResources(
  run: Runner,
  running: RunningContainer[]
): Promise<Record<EnvId, ResourceStats>> {
  let targets = running;
  for (let attempt = 0; attempt < 2 && targets.length > 0; attempt++) {
    const r = await run(
      "docker",
      [
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
        ...targets.map((t) => t.containerId),
      ],
      {
        timeoutMs: STATS_TIMEOUT_MS,
      }
    );
    if (r.exitCode === 0 && !r.timedOut) {
      const rows = [...parseStats(r.stdout)];
      const out: Record<EnvId, ResourceStats> = {};
      for (const t of targets) {
        const hit = rows.find(([id]) => sameContainer(t.containerId, id));
        if (hit) out[t.envId] = hit[1];
      }
      return out;
    }
    // One container that is gone fails the whole call: drop the ones docker names and try once more.
    const gone = [...r.stderr.matchAll(/No such container: (\S+)/g)].map(
      (m) => m[1]
    );
    if (gone.length === 0) break;
    targets = targets.filter(
      (t) => !gone.some((g) => sameContainer(t.containerId, g))
    );
  }
  return {};
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run test/server/resources.test.ts` Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/resources.ts test/server/resources.test.ts src/shared/types.ts
git commit -m "feat(server): parse docker stats into per-environment CPU and memory

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Stats in the store and the snapshot

**Files:**

- Modify: `src/server/state.ts`
- Test: `test/server/state.test.ts`

**Interfaces:**

- Consumes: `ResourceStats` (Task 1), `RunningContainer` from `src/server/resources.ts`.
- Produces: `StateStore.runningContainers(): RunningContainer[]`, `StateStore.setResources(r: Record<EnvId, ResourceStats>): void`; `snapshot().resources` when non-empty.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("StateStore", …)` block of `test/server/state.test.ts`:

```ts
it("lists the containers of running main and task environments", () => {
  const { store } = make();
  store.setProjects([p("a"), p("b")]);
  store.putEnvironment({
    id: "env-1",
    projectId: "a",
    worktree: { path: "/w/x", hostPath: "/h/x", branch: "x" },
  });
  store.updateRuntime("a", { containerState: "running", containerId: "ca" });
  store.updateRuntime("b", { containerState: "stopped", containerId: "cb" });
  store.updateRuntime("env-1", {
    containerState: "running",
    containerId: "ce",
  });
  expect(store.runningContainers()).toEqual([
    { envId: "a", containerId: "ca" },
    { envId: "env-1", containerId: "ce" },
  ]);
});

it("puts resources in the snapshot and emits only when they change", () => {
  const { store } = make();
  store.setProjects([p("a")]);
  expect(store.snapshot().resources).toBeUndefined();
  const fn = vi.fn();
  store.subscribe(fn);
  const stats = { a: { cpu: 3, memory: 1024 ** 2, memoryLimit: 1024 ** 3 } };
  store.setResources(stats);
  store.setResources(structuredClone(stats));
  expect(fn).toHaveBeenCalledTimes(1);
  expect(store.snapshot().resources).toEqual(stats);
  store.setResources({});
  expect(store.snapshot().resources).toBeUndefined();
});

it("drops a removed environment's resources", () => {
  const { store } = make();
  store.setProjects([p("a")]);
  store.putEnvironment({
    id: "env-1",
    projectId: "a",
    worktree: { path: "/w/x", hostPath: "/h/x", branch: "x" },
  });
  store.setResources({ "env-1": { cpu: 1, memory: 0, memoryLimit: 1 } });
  store.removeEnvironment("env-1");
  expect(store.snapshot().resources).toBeUndefined();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/server/state.test.ts` Expected: FAIL, `store.runningContainers is not a function` / `store.setResources is not a function`.

- [ ] **Step 3: Implement**

In `src/server/state.ts`:

Add `ResourceStats` to the type import from `../shared/types`, and `import type { RunningContainer } from "./resources";`.

Add a field after `private usageTotals?: UsageTotals;`:

```ts
  private resourceStats: Record<EnvId, ResourceStats> = {};
```

In `removeEnvironment`, after `this.sessions.delete(id);`:

```ts
delete this.resourceStats[id];
```

After `setUsage`:

```ts
  setResources(stats: Record<EnvId, ResourceStats>): void {
    if (JSON.stringify(this.resourceStats) === JSON.stringify(stats)) return;
    this.resourceStats = stats;
    this.emit();
  }

  /** The containers of running environments, main and task, for the resource sampler. */
  runningContainers(): RunningContainer[] {
    return [...this.projectsById.keys(), ...this.envs.keys()].flatMap((envId) => {
      const r = this.runtimes.get(envId);
      return r?.containerState === "running" && r.containerId ? [{ envId, containerId: r.containerId }] : [];
    });
  }
```

In `snapshot()`, after the `usage` spread:

```ts
      ...(Object.keys(this.resourceStats).length > 0 ? { resources: this.resourceStats } : {}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/server/state.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/state.ts test/server/state.test.ts
git commit -m "feat(server): resource stats in the dashboard snapshot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The sampler loop, wired into the CLI

**Files:**

- Modify: `src/server/resources.ts`
- Modify: `src/server/cli.ts` (around the `refresh` interval and `shutdown`, ~lines 188–198)
- Test: `test/server/resources.test.ts`

**Interfaces:**

- Consumes: `sampleResources` (Task 1); `StateStore.runningContainers`, `StateStore.setResources` (Task 2).
- Produces: `startResourceSampler(opts: { run: Runner; store: Pick<StateStore, "runningContainers" | "setResources">; intervalMs?: number }): { stop(): void }`.

- [ ] **Step 1: Write the failing tests**

Add to `test/server/resources.test.ts` (extend the imports: `afterEach, vi` from vitest, `startResourceSampler` from the module, and `RunResult` type from `../../src/server/exec`):

```ts
describe("startResourceSampler", () => {
  afterEach(() => vi.useRealTimers());

  const storeWith = (running: { envId: string; containerId: string }[]) => {
    const writes: Record<string, unknown>[] = [];
    return {
      writes,
      store: {
        runningContainers: () => running,
        setResources: (r: Record<string, never>) => void writes.push(r),
      },
    };
  };

  it("samples at once, then every interval", async () => {
    vi.useFakeTimers();
    const { run, calls } = fakeRunner(() => ({
      stdout: line("aaaaaaaaaaaa", "5%", "1GiB / 2GiB"),
    }));
    const { store, writes } = storeWith([
      { envId: "proj", containerId: FULL_A },
    ]);
    const sampler = startResourceSampler({ run, store, intervalMs: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    expect(writes).toEqual([
      { proj: { cpu: 5, memory: GiB, memoryLimit: 2 * GiB } },
    ]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls).toHaveLength(2);
    sampler.stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
  });

  it("clears the stats when nothing runs", async () => {
    vi.useFakeTimers();
    const { run, calls } = fakeRunner();
    const { store, writes } = storeWith([]);
    const sampler = startResourceSampler({ run, store });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(0);
    expect(writes).toEqual([{}]);
    sampler.stop();
  });

  it("never overlaps rounds and writes nothing after stop", async () => {
    vi.useFakeTimers();
    let finish!: (r: Partial<RunResult>) => void;
    const { run, calls } = fakeRunner(
      () => new Promise<Partial<RunResult>>((resolve) => (finish = resolve))
    );
    const { store, writes } = storeWith([
      { envId: "proj", containerId: FULL_A },
    ]);
    const sampler = startResourceSampler({ run, store, intervalMs: 5000 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1);
    sampler.stop();
    finish({ stdout: line("aaaaaaaaaaaa", "5%", "1GiB / 2GiB") });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(writes).toEqual([]);
    expect(calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/server/resources.test.ts` Expected: FAIL, `startResourceSampler is not a function` (or not exported).

- [ ] **Step 3: Implement the loop**

Append to `src/server/resources.ts` (add `import type { StateStore } from "./state";` at the top):

```ts
export interface SamplerOptions {
  run: Runner;
  store: Pick<StateStore, "runningContainers" | "setResources">;
  intervalMs?: number;
}

/** Samples now and then `intervalMs` after each round ends, so slow `docker stats` calls never overlap. */
export function startResourceSampler(opts: SamplerOptions): { stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const round = async () => {
    const stats = await sampleResources(
      opts.run,
      opts.store.runningContainers()
    ).catch(() => ({}));
    if (stopped) return;
    opts.store.setResources(stats);
    timer = setTimeout(() => void round(), opts.intervalMs ?? 5000);
  };
  void round();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
```

`state.ts` imports a type from `resources.ts` and `resources.ts` imports a type from `state.ts`; both are `import type`, so there's no runtime cycle.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/server/resources.test.ts` Expected: PASS (10 tests).

- [ ] **Step 5: Wire it into the CLI**

In `src/server/cli.ts`, add `import { startResourceSampler } from "./resources";` with the other `./` imports. After

```ts
const refresh = setInterval(
  () => void orchestrator.refreshContainers().catch(() => {}),
  10_000
);
```

add

```ts
const sampler = startResourceSampler({ run: spawnRunner, store });
```

and in `shutdown`, after `clearInterval(refresh);`:

```ts
sampler.stop();
```

- [ ] **Step 6: Typecheck and run the server tests**

Run: `pnpm typecheck && pnpm vitest run test/server` Expected: no type errors; all PASS.

- [ ] **Step 7: Commit**

`cli.ts` also holds the partner's uncommitted change (see Global Constraints). If it is still uncommitted, stop and ask instead of committing.

```bash
git add src/server/resources.ts src/server/cli.ts test/server/resources.test.ts
git commit -m "feat(server): sample docker stats every 5 seconds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web helpers

**Files:**

- Create: `src/web/resources.ts`
- Test: `test/web/resources.test.ts`

**Interfaces:**

- Consumes: `DashboardSnapshot.resources`, `ResourceStats` (Task 1); `Checkout` from `src/web/checkouts.ts`; `envOfDirectory` from `src/web/derive.ts`.
- Produces: `formatCpu(cpu: number): string`, `formatMemory(bytes: number): string`, `ProjectResources { cpu: number; memory: number; count: number }`, `projectResources(snapshot: DashboardSnapshot | undefined, view: ProjectView): ProjectResources | undefined`, `checkoutResources(snapshot: DashboardSnapshot | undefined, view: ProjectView, checkout: Checkout): ResourceStats | undefined`.

- [ ] **Step 1: Write the failing tests**

`test/web/resources.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import type {
  DashboardSnapshot,
  EnvironmentView,
  ProjectView,
  ResourceStats,
} from "../../src/shared/types";
import { checkouts } from "../../src/web/checkouts";
import {
  checkoutResources,
  formatCpu,
  formatMemory,
  projectResources,
} from "../../src/web/resources";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const stats = (cpu: number, memory: number): ResourceStats => ({
  cpu,
  memory,
  memoryLimit: 8 * GiB,
});

const env = (id: string, path: string): EnvironmentView =>
  ({
    id,
    worktree: { path, hostPath: `/h${path}`, branch: id },
    runtime: { projectId: "p", containerState: "running", opencode: "healthy" },
    openUrl: `http://${id}`,
  }) as EnvironmentView;

const view: ProjectView = {
  project: {
    id: "p",
    name: "demo",
    path: "/src/demo",
    devcontainerPath: "/src/demo/x",
  },
  runtime: {
    projectId: "p",
    containerState: "running",
    opencode: "healthy",
    workspaceFolder: "/workspaces/demo",
    worktrees: [
      { path: "/workspaces/demo.worktrees/own", branch: "own" },
      { path: "/workspaces/demo.worktrees/shared", branch: "shared" },
    ],
  },
  sessions: [],
  openUrl: "http://p",
  environments: [
    env("env-own", "/workspaces/demo.worktrees/own"),
    env("env-off", "/elsewhere"),
  ],
};

const snap = (
  resources?: DashboardSnapshot["resources"]
): DashboardSnapshot => ({
  roots: [],
  preflight: { errors: [] },
  editors: [],
  projects: [view],
  ...(resources ? { resources } : {}),
});

describe("formatting", () => {
  it("shows CPU as docker does", () => {
    expect(formatCpu(0)).toBe("0%");
    expect(formatCpu(153)).toBe("153%");
  });

  it("shows MiB below a GiB and GiB with one decimal above", () => {
    expect(formatMemory(0)).toBe("0 MiB");
    expect(formatMemory(512 * MiB)).toBe("512 MiB");
    expect(formatMemory(1023 * MiB)).toBe("1023 MiB");
    expect(formatMemory(GiB)).toBe("1.0 GiB");
    expect(formatMemory(1.248 * GiB)).toBe("1.2 GiB");
    expect(formatMemory(31.24 * GiB)).toBe("31.2 GiB");
  });
});

describe("projectResources", () => {
  it("sums the main and task environments that have stats", () => {
    const r = projectResources(
      snap({
        p: stats(10, GiB),
        "env-own": stats(5, 512 * MiB),
        other: stats(99, GiB),
      }),
      view
    );
    expect(r).toEqual({ cpu: 15, memory: GiB + 512 * MiB, count: 2 });
  });

  it("counts task environments when the main one is stopped", () => {
    expect(projectResources(snap({ "env-off": stats(3, MiB) }), view)).toEqual({
      cpu: 3,
      memory: MiB,
      count: 1,
    });
  });

  it("is undefined without stats", () => {
    expect(projectResources(snap(), view)).toBeUndefined();
    expect(projectResources(undefined, view)).toBeUndefined();
    expect(
      projectResources(snap({ other: stats(1, 1) }), view)
    ).toBeUndefined();
  });
});

describe("checkoutResources", () => {
  const s = snap({ p: stats(10, GiB), "env-own": stats(5, MiB) });
  const [main, own, shared] = checkouts(view);

  it("gives the main checkout the main container's numbers", () => {
    expect(checkoutResources(s, view, main)).toEqual(stats(10, GiB));
  });

  it("gives a worktree with its own container that container's numbers", () => {
    expect(checkoutResources(s, view, own)).toEqual(stats(5, MiB));
  });

  it("gives a worktree sharing the main container nothing", () => {
    expect(checkoutResources(s, view, shared)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/web/resources.test.ts` Expected: FAIL, cannot resolve `../../src/web/resources`.

- [ ] **Step 3: Implement**

`src/web/resources.ts`:

```ts
import type {
  DashboardSnapshot,
  ProjectView,
  ResourceStats,
} from "../shared/types";
import type { Checkout } from "./checkouts";
import { envOfDirectory } from "./derive";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

/** Percent of one core, as `docker stats` shows it. */
export function formatCpu(cpu: number): string {
  return `${cpu}%`;
}

export function formatMemory(bytes: number): string {
  return bytes < GiB
    ? `${Math.round(bytes / MiB)} MiB`
    : `${(bytes / GiB).toFixed(1)} GiB`;
}

/** No limit: a container without one reports the host's memory, so a sum would count the host once per container. */
export interface ProjectResources {
  cpu: number;
  memory: number;
  /** Containers with stats. */
  count: number;
}

/** The project's main and task containers added up; undefined when none has stats. */
export function projectResources(
  snapshot: DashboardSnapshot | undefined,
  view: ProjectView
): ProjectResources | undefined {
  const all = snapshot?.resources;
  if (!all) return undefined;
  const found = [view.project.id, ...view.environments.map((e) => e.id)]
    .map((id) => all[id])
    .filter((s): s is ResourceStats => s !== undefined);
  if (found.length === 0) return undefined;
  return {
    cpu: found.reduce((n, s) => n + s.cpu, 0),
    memory: found.reduce((n, s) => n + s.memory, 0),
    count: found.length,
  };
}

/** The numbers of the container a checkout runs in; undefined for a worktree sharing the main one, already counted there. */
export function checkoutResources(
  snapshot: DashboardSnapshot | undefined,
  view: ProjectView,
  checkout: Checkout
): ResourceStats | undefined {
  if (!checkout.worktree) return snapshot?.resources?.[view.project.id];
  const env = envOfDirectory(view, checkout.directory);
  return env ? snapshot?.resources?.[env.id] : undefined;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run test/web/resources.test.ts` Expected: PASS (8 tests). If `checkouts(view)` doesn't yield `[main, own, shared]` in that order, check the `Worktree` fields `checkouts()` reads (`src/web/checkouts.ts:21`) and fix the fixture, not the helper.

- [ ] **Step 5: Commit**

```bash
git add src/web/resources.ts test/web/resources.test.ts
git commit -m "feat(web): per-project and per-checkout resource helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Show the numbers on the tiles

**Files:**

- Create: `src/web/components/ResourceStat.tsx`
- Modify: `src/web/pages/Overview.tsx` (`ProjectTile`, ~line 138)
- Modify: `src/web/pages/ProjectOverview.tsx` (`CheckoutCard`, ~line 160)

**Interfaces:**

- Consumes: `formatCpu`, `formatMemory`, `projectResources`, `checkoutResources` (Task 4); `useDash()` from `src/web/DashboardContext.tsx` (returns `{ snapshot, … }`).
- Produces: `ResourceStat({ cpu, memory, memoryLimit?, count? })`.

- [ ] **Step 1: The component**

`src/web/components/ResourceStat.tsx`:

```tsx
import { formatCpu, formatMemory } from "../resources";

/** `CPU 12% · 1.3 GiB`; the tooltip has the container count or the memory limit. */
export function ResourceStat({
  cpu,
  memory,
  memoryLimit,
  count,
}: {
  cpu: number;
  memory: number;
  memoryLimit?: number;
  count?: number;
}) {
  const title = [
    count !== undefined
      ? `${count} ${count === 1 ? "container" : "containers"}`
      : undefined,
    memoryLimit !== undefined
      ? `${formatMemory(memory)} of ${formatMemory(memoryLimit)}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <span className="tabular-nums" title={title || undefined}>
      CPU {formatCpu(cpu)} · {formatMemory(memory)}
    </span>
  );
}
```

- [ ] **Step 2: Project tile**

In `src/web/pages/Overview.tsx`, add imports:

```ts
import { ResourceStat } from "../components/ResourceStat";
import { projectResources } from "../resources";
```

In `ProjectTile`, after `const navigate = useNavigate();`:

```ts
const { snapshot } = useDash();
const resources = projectResources(snapshot, view);
```

In the stats row (`<div className="flex min-h-5 flex-wrap gap-x-3.5 …">`), after the closing `)}` of the `running ? (…) : (…)` expression and before the row's `</div>`:

```tsx
{
  resources && <ResourceStat {...resources} />;
}
```

- [ ] **Step 3: Checkout card**

In `src/web/pages/ProjectOverview.tsx`, add imports:

```ts
import { ResourceStat } from "../components/ResourceStat";
import { checkoutResources } from "../resources";
```

In `CheckoutCard`, after `const to = checkoutPath(view.project.id, c.target);`:

```ts
const { snapshot } = useDash();
const resources = checkoutResources(snapshot, view, c);
```

In its stats row, after `{n.attention + n.running + n.idle === 0 && <span>No sessions</span>}`:

```tsx
{
  resources && <ResourceStat {...resources} />;
}
```

- [ ] **Step 4: Typecheck and run all tests**

Run: `pnpm typecheck && pnpm test` Expected: no type errors; all PASS.

- [ ] **Step 5: See it in the app**

Use the `run` skill to start opendevhub with at least one running environment. Open the Overview and a project page, and check:

- the project tile shows `CPU n% · x` and its tooltip `n containers`
- the main checkout card and a worktree with its own container each show their numbers, with tooltip `x of y`; a shared worktree shows none
- the numbers change within ~10 s under load (e.g. `docker exec <container> sh -c 'yes > /dev/null & sleep 15; kill %1'`)
- stopping a container removes its numbers

- [ ] **Step 6: Commit**

```bash
git add src/web/components/ResourceStat.tsx src/web/pages/Overview.tsx src/web/pages/ProjectOverview.tsx
git commit -m "feat(web): CPU and memory on project tiles and checkout cards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
