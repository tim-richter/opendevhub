# Resource stats: CPU and memory per environment

Date: 2026-10-05
Status: Draft for review
Backlog item: "Resource stats" (Medium).

## Problem

Every environment is a container: a project's main one, plus one per isolated task. The dashboard
shows whether each is running, but not what it costs the machine. A runaway build, a dev server
spinning at 100% or a container near its memory limit is invisible until the host slows down,
and then there is no way to tell which environment did it.

The goal is a glance: "which environment is using my CPU and memory right now?" Not history, not
alerts.

## Scope

In:

- Current CPU and memory for each running environment, from `docker stats`.
- Shown on the Overview's project tiles (summed over the project's containers) and on the project
  page's checkout cards (per environment).

Out: history, trends and sparklines, charts, alerts or limits, network and block I/O, PIDs,
Docker Compose service containers other than the devcontainer itself.

### Success criteria

- A running project's tile on the Overview shows its CPU % and memory, the sum over its main and
  task containers.
- A checkout card shows the numbers of the container that checkout runs in, if it has its own.
- The numbers follow load within about 10 seconds.
- A stopped environment shows no numbers, and a failing `docker stats` shows none either, without
  an error.

## Approach

A separate sampler in the server polls `docker stats` and hands the result to the `StateStore`,
which puts it in the snapshot next to `projects`. Stats change every few seconds and container
lifecycle doesn't, so they stay out of `ProjectRuntime`, whose fields `updateRuntime` compares
and persists.

Considered and dropped:

- **Stats on `ProjectRuntime`.** Less code, but volatile numbers would sit among lifecycle fields
  and the durable keys.
- **A `/api/resources` endpoint the browser polls.** Keeps the snapshot unchanged, but adds a
  second refresh path on the client for little gain.
- **The Docker Engine API over the socket.** Raw numbers instead of strings, but the server does
  everything else through the `docker` CLI and a `Runner`, which tests fake.

The snapshot is re-sent to every dashboard on each change, so values are rounded before they reach
the store (CPU to a whole percent, memory to 1 MiB) and the store only emits when they changed.
An idle container then barely causes updates.

## Data

`src/shared/types.ts`:

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

export interface DashboardSnapshot {
  // …
  /** By environment id (a main environment's id is its project id); running environments only. */
  resources?: Record<EnvId, ResourceStats>;
}
```

## Server

### Parsing and sampling (`src/server/resources.ts`)

- `parseStats(stdout: string): Map<string, ResourceStats>` reads `docker stats --format '{{json .}}'`
  output, one JSON object per line, keyed by the short `ID` docker prints. `CPUPerc` is
  `"12.34%"`; `MemUsage` is `"<used> / <limit>"` with units `B`, `KiB`, `MiB`, `GiB`, `TiB` (and
  `kB`/`MB`/`GB` decimal units, which docker uses on some platforms). A line with `--` values (a
  container stopping mid-sample) or that doesn't parse is skipped.
- `startResourceSampler({ run, store, intervalMs = 5000 })` returns `{ stop() }`. Each round:
  1. Collect the `containerId` of every environment whose `containerState` is `running`, main and
     task, with its environment id. `StateStore` gets a small `runningContainers(): { envId,
     containerId }[]` for this.
  2. None running: `store.setResources({})` and wait for the next round, with no docker call.
  3. Otherwise one `docker stats --no-stream --format '{{json .}}' <ids…>` call (15 s timeout).
     Match lines to environments by id prefix (docker prints 12 characters; `containerId` is the
     full id).
  4. `store.setResources(byEnvId)`. A non-zero exit or a timeout sets `{}`.
- Rounds don't overlap: the next one is scheduled when the previous ends (`setTimeout`, not
  `setInterval`), since `--no-stream` itself takes about a second.

### Store (`src/server/state.ts`)

- `setResources(r: Record<EnvId, ResourceStats>)`: compares with the current value as JSON and
  emits only on a change, like `setUsage`.
- `snapshot()` adds `resources` when it isn't empty.
- `removeEnvironment` drops the environment's entry.

### Wiring (`src/server/cli.ts`)

Start the sampler after the orchestrator, next to the 10 s container refresh, with the same
`Runner`; stop it in `shutdown` before the orchestrator.

## Web

### Helpers (`src/web/resources.ts`)

- `formatCpu(cpu)`: `"12%"`.
- `formatMemory(bytes)`: binary units as docker shows them, one decimal from GiB up: `"512 MiB"`,
  `"1.3 GiB"`.
- `projectResources(snapshot, view)`: sum of `cpu`, `memory` and `memoryLimit` over the main
  environment and the project's task environments that have stats, with `count`; undefined
  when none do.
- `checkoutResources(snapshot, view, checkout)`: the stats of the environment the checkout runs
  in. A worktree with its own environment gets that environment's; the main checkout gets the
  main environment's; a worktree sharing the main container gets undefined, because its load is
  already in the main container's numbers.

### Tiles

- **Overview `ProjectTile`** (`src/web/pages/Overview.tsx`): when running and there are stats,
  `CPU 12% · 1.3 GiB` at the end of the stats row, `tabular-nums`. The tooltip:
  `3 containers · 1.3 GiB of 31.2 GiB`.
- **`CheckoutCard`** (`src/web/pages/ProjectOverview.tsx`): the same text in its stats row, with
  the tooltip `1.3 GiB of 31.2 GiB`.

Both use one small `ResourceStat` component so the format and tooltip stay the same.

## Errors

`docker stats` failing, timing out or printing unparseable lines removes the numbers; nothing
is logged per round and nothing is shown. The next round tries again. A container that stops
mid-sample is left out until the store sees it running again.

## Testing

- `test/server/resources.test.ts`: `parseStats` with each unit, the `--` placeholder and junk
  lines; a sampler round with a fake `Runner` (ids passed, prefix matching, no call when nothing
  runs, `{}` on failure).
- `test/server/state.test.ts`: `setResources` emits on a change only; the snapshot includes
  `resources`; `removeEnvironment` drops its entry.
- `test/web/resources.test.ts`: formatting, project sums over main and task environments, and the
  checkout cases (own environment, main, shared worktree).
