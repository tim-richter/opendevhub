# Per-task Environments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a worktree run in its own devcontainer ("Own container"), started from a reused base image, with its own opencode, relay, route, port forwards and monitor, while the project's main container stays exactly as it is today.

**Architecture:** An _environment_ is one container plus its opencode, relay, route, forwards and monitor. Part A refactors the orchestrator so all of that is keyed by `EnvId`; the main environment's id is the project id, so nothing visible changes. Part B adds task environments: a pure module generates an override `devcontainer.json` (image pinned, worktree mounted, `.git` mounted), an `Images` service builds one base image per project and image key, and the orchestrator starts, stops, adopts and removes task containers and routes opencode calls to the environment that owns a checkout.

**Tech Stack:** TypeScript (strict), Node ≥ 20, Hono, React 19, vitest, devcontainer CLI 0.89, Docker.

**Spec:** `docs/superpowers/specs/2026-10-03-per-task-environments-design.md` — this plan covers its delivery phases 1 and 2 (`warmStart: "image"` only).

## Global Constraints

- No new runtime dependencies. Commands: `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm test:e2e`.
- The main environment's id equals the project id, and the main container keeps exactly the id label `opendevhub.project=<projectId>`, so existing containers are re-adopted with no migration.
- Task containers are labelled `opendevhub.env=<envId>` and `opendevhub.env-project=<projectId>` and **never** `opendevhub.project` (see Deviations, 1).
- Env id: `<projectId>-<branch slug ≤ 20>-<hash4>`, at most 63 characters (a DNS label); the opencode proxy host is `http://<envId>.localhost:<port>`.
- Isolation defaults to `shared`. Settings: `customizations.opendevhub.isolation` (`"shared"` | `"isolated"`) and `customizations.opendevhub.keyFiles` (default `[]`) in `devcontainer.json`; `config.json` `projects: { "<project path>": { … } }` overrides them.
- Image key: `sha256(cliVersion, tree(.devcontainer), tree(.devcontainer.json), files in keyFiles, generation)`, read at the worktree's `HEAD`; `generation` is `0` until phase 4. Base image: `opendevhub/<projectId>:<key12>-base`, built with `devcontainer build --workspace-folder <task worktree> --image-name …`.
- Override config: `image` pinned; `build`, `dockerFile`, `context`, `dockerComposeFile`, `service`, `runServices`, `features`, `overrideFeatureInstallOrder` removed; every lifecycle key except `initializeCommand` removed; `workspaceMount` = worktree host path → worktree container path; `workspaceFolder` = worktree container path; `mounts` = original mounts plus `<project>/.git` → `<main workspace>/.git`; `--name …` removed from `runArgs` (logged). Written to `$XDG_STATE_HOME/opendevhub/envs/<envId>/devcontainer.json` (default `~/.local/state`).
- Refused for isolation (the task runs shared; the message names the cause): `dockerComposeFile`; `appPort`; `runArgs` with `-p`, `--publish`, `-P`, `--publish-all`; host networking.
- UI copy: "Own container", "Shared", field label "Environment".

## Deviations from the spec (verified against devcontainer CLI 0.89.0 while planning)

1. **Labels.** The CLI's `findDevContainer` lists containers matching _all_ id labels and takes the first. A task container also carrying `opendevhub.project=<id>` could be picked by the main environment's `up` and `exec`. So task containers use the two `opendevhub.env*` labels only.
2. **Git stays in the main container.** Review status, commit, update, merge, worktree add/remove and the image-key `rev-parse` keep running there; task containers mount the same worktree at the same path. Calls to opencode (sessions, diff, generate, replies) go to the task environment's opencode.
3. **`vsc-<dir>-<hash>-uid` images.** `up` with a pinned image still builds the remote-user UID image, named after the worktree folder. Removing an environment removes that image (best effort).
4. **`${containerWorkspaceFolder}`.** `read-configuration` substitutes it with `/workspaces/<worktree dir>`. The override config rewrites that path to the worktree's real container path. Lifecycle commands come from the image label and can't be rewritten, so a config whose lifecycle commands contain the guessed path is refused for isolation.
5. **No opencode data volume yet.** It arrives with Recreate (phase 4). Removing an environment deletes its sessions; the confirmation says so.
6. `exec` on a task container needs `--override-config`; without it the CLI chdirs into the guessed folder and fails.

## Review Focus

1. A main-environment lookup must never match a task container — pinned in Task 7 (`listManaged`, `parseInspect`) and Task 10 (adopt ignores env containers on the main path).
2. Removing a worktree whose container can't be removed must keep the worktree and report why — pinned in Task 11 (`removeWorktree` keeps the worktree when `docker rm` fails).
3. Two variants needing the same new image build it once — pinned in Task 8 (concurrent `ensureBase`).
4. After an opendevhub restart, running task containers are re-adopted with route, relay, ports and monitor; a container with no record is ignored and logged, not adopted as a project — pinned in Task 10.
5. Stopping the project stops its task containers; `refreshContainers` notices a task container stopped outside opendevhub — pinned in Task 10.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/shared/types.ts` | `EnvId`, `Isolation`, `EnvWorktree`, `EnvironmentView`, `IsolationInfo`; new fields on `ProjectView`, `SessionSummary`, `TaskRequest`, `TaskVariantResult` |
| `src/server/containers.ts` | `ExecTarget`; env labels; `readConfig`, `build`, `imageExists`, `remove`, `removeImage` |
| `src/server/env-config.ts` (new) | Pure: env ids, settings, isolation blockers, the override config |
| `src/server/env-files.ts` (new) | Where override configs live on disk |
| `src/server/images.ts` (new) | Image key, base image ref, `Images.ensureBase` |
| `src/server/git.ts` | `headObjects` (object ids at `HEAD`) |
| `src/server/config.ts` | `projects` overrides, `stateDir()`, persisted environments |
| `src/server/state.ts` | Environment records, sessions per environment, snapshot |
| `src/server/status.ts`, `monitor.ts` | Sessions carry `envId` |
| `src/server/orchestrator.ts` | Lifecycle keyed by `EnvId`; task environment lifecycle; routing |
| `src/server/tasks.ts` | `environment` in task requests |
| `src/server/hosts.ts`, `server.ts`, `cli.ts`, `dashboard-api.ts` | `<envId>.localhost`, wiring, routes |
| `src/web/api.ts`, `derive.ts` | Env calls and helpers |
| `src/web/components/EnvBadge.tsx` (new), pages | UI |
| `test/e2e/environments.e2e.ts` (new) | Real Docker |

---

# Part A — Environments with `main` only (no behaviour change)

### Task 1: Shared types and an empty `environments` list in the snapshot

**Files:**

- Modify: `src/shared/types.ts`
- Modify: `src/server/state.ts` (the `snapshot()` method)
- Modify: every `ProjectView` literal in tests (found by `pnpm typecheck` in Step 5)
- Test: `test/server/state.test.ts`

**Interfaces:**

- Produces: `EnvId`, `Isolation`, `EnvWorktree`, `EnvironmentView`, `IsolationInfo`; `ProjectView.environments: EnvironmentView[]`, `ProjectView.isolation?: IsolationInfo`; `SessionSummary.envId?: EnvId`; `TaskRequest.environment?: Isolation`; `TaskVariantResult.envId?: EnvId`, `TaskVariantResult.notice?: string`.

- [ ] **Step 1: Write the failing test** — add to the `describe` in `test/server/state.test.ts` that holds the snapshot test:

```ts
it("lists no task environments for a project that has none", () => {
  const { store } = make();
  store.setProjects([p("a")]);
  expect(store.snapshot().projects[0].environments).toEqual([]);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/server/state.test.ts` Expected: FAIL — `expected undefined to deeply equal []`.

- [ ] **Step 3: Add the types** — in `src/shared/types.ts`, after `export type ProjectId = string;`:

```ts
/** One devcontainer with its own opencode. A project's main environment has the project's id. */
export type EnvId = string;

/** Whether a task's worktree runs in the project's container or in its own. */
export type Isolation = "shared" | "isolated";

/** The worktree a task environment serves, as the main container and this machine see it. */
export interface EnvWorktree {
  path: string;
  hostPath: string;
  branch: string;
}
```

After `export type PublicRuntime = …;`:

```ts
/** A worktree's own container. */
export interface EnvironmentView {
  id: EnvId;
  worktree: EnvWorktree;
  /** The base image it was last started from. */
  image?: { key: string; ref: string };
  runtime: PublicRuntime;
  /** Its opencode, like ProjectView.openUrl. */
  openUrl: string;
}

export interface IsolationInfo {
  /** What new tasks use unless they choose. */
  default: Isolation;
  /** Why worktrees of this project can't get their own container; tasks then run shared. */
  unsupported?: string;
}
```

In `SessionSummary`, after `projectId: ProjectId;`:

```ts
  /** The task environment whose opencode runs it; absent for the main environment. */
  envId?: EnvId;
```

In `TaskRequest`, after `base?: string;`:

```ts
  /** Worktree tasks only; the project's default when absent. */
  environment?: Isolation;
```

In `TaskVariantResult`, after `sessionId?: string;`:

```ts
  /** Set when the variant runs in its own container. */
  envId?: EnvId;
  /** Why the variant runs shared although its own container was asked for. */
  notice?: string;
```

In `ProjectView`, after `openUrl: string;`:

```ts
  /** Worktrees with their own container. The main environment is `runtime`. */
  environments: EnvironmentView[];
  /** Known once the main container has started. */
  isolation?: IsolationInfo;
```

- [ ] **Step 4: Fill the field in the snapshot** — in `src/server/state.ts` `snapshot()`, add `environments: [],` after `openUrl: projectUrl(project.id, this.opts.port),`.

- [ ] **Step 5: Fix test fixtures**

Run: `pnpm typecheck` Expected: errors `Property 'environments' is missing` in test files that build a `ProjectView` literal (at least `test/web/derive.test.ts`, `test/web/tasks.test.ts`, `test/web/review.test.ts`, `test/server/publish.test.ts`). Add `environments: [],` next to each literal's `openUrl:` until `pnpm typecheck` passes.

- [ ] **Step 6: Run the tests**

Run: `pnpm test` Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/shared/types.ts src/server/state.ts test
git commit -m "feat: types for task environments; the snapshot lists them"
```

### Task 2: `ExecTarget` — address a container by labels and an override config

**Files:**

- Modify: `src/server/containers.ts`
- Modify: `src/server/opencode/runtime.ts`, `src/server/relay/runtime.ts`
- Test: `test/server/containers.test.ts`

**Interfaces:**

- Produces: `interface ExecTarget { id: string; path: string; idLabels?: string[]; overrideConfig?: string }`. `Containers.up(target: ExecTarget, opts)`, `readConfiguration(target)`, `workspaceFolder(target)`, `exec(target, command, opts)`. `OpencodeRuntime.resolveBinary/ensureRunning/stopServer(target: ExecTarget, …)`, `RelayRuntime.ensureRunning/stop(target: ExecTarget, …)`. A `Project` is an `ExecTarget` (structurally), so existing callers compile unchanged.

- [ ] **Step 1: Write the failing tests** — add to `test/server/containers.test.ts`:

```ts
describe("exec targets", () => {
  it("keeps addressing a project's container by its project label", async () => {
    const { run, calls } = fakeRunner();
    await new Containers(run).exec(project, ["pwd"]);
    expect(calls[0].args).toEqual([
      "exec",
      "--workspace-folder",
      "/src/demo",
      "--id-label",
      `${LABEL}=demo-1a2b3c`,
      "pwd",
    ]);
  });

  it("addresses a task environment by its own labels and generated config", async () => {
    const { run, calls } = fakeRunner();
    const target = {
      id: "demo-1a2b3c-feat-0a1b",
      path: "/src/demo.worktrees/feat",
      idLabels: [
        "opendevhub.env=demo-1a2b3c-feat-0a1b",
        "opendevhub.env-project=demo-1a2b3c",
      ],
      overrideConfig: "/state/envs/demo-1a2b3c-feat-0a1b/devcontainer.json",
    };
    await new Containers(run).exec(target, ["pwd"]);
    expect(calls[0].args).toEqual([
      "exec",
      "--workspace-folder",
      "/src/demo.worktrees/feat",
      "--id-label",
      "opendevhub.env=demo-1a2b3c-feat-0a1b",
      "--id-label",
      "opendevhub.env-project=demo-1a2b3c",
      "--override-config",
      "/state/envs/demo-1a2b3c-feat-0a1b/devcontainer.json",
      "pwd",
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify the second fails**

Run: `pnpm vitest run test/server/containers.test.ts` Expected: the task-environment test FAILS (the args contain `opendevhub.project=demo-1a2b3c-feat-0a1b`).

- [ ] **Step 3: Implement** — in `src/server/containers.ts`, add after `LABEL`:

```ts
/**
 * The container a devcontainer CLI call addresses. A Project is one: its main environment, found by
 * `opendevhub.project=<id>`. A task environment sets its own labels and the generated config.
 */
export interface ExecTarget {
  id: string;
  /** Host folder passed as --workspace-folder. */
  path: string;
  /** Defaults to `opendevhub.project=<id>`. */
  idLabels?: string[];
  /** A generated devcontainer.json that replaces the repo's (task environments). */
  overrideConfig?: string;
}
```

Replace `idArgs`:

```ts
  private idArgs(t: ExecTarget): string[] {
    const args = ["--workspace-folder", t.path];
    for (const label of t.idLabels ?? [`${LABEL}=${t.id}`]) args.push("--id-label", label);
    if (t.overrideConfig) args.push("--override-config", t.overrideConfig);
    return args;
  }
```

Change the parameter `project: Project` to `target: ExecTarget` in `up`, `readConfiguration`, `workspaceFolder` and `exec`, and replace `project` with `target` in their bodies (`up`'s fallback becomes `` `/workspaces/${path.basename(target.path)}` ``). Remove the now-unused `Project` import.

In `src/server/opencode/runtime.ts`: import `type ExecTarget` from `"../containers"` instead of `Project`, and change `resolveBinary(project: Project)`, `ensureRunning(project: Project, args)` and `stopServer(project: Project)` to take `target: ExecTarget`, replacing `project` with `target` in their bodies.

In `src/server/relay/runtime.ts`: the same for `ensureRunning`, `stop` and the private `start`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/server && pnpm typecheck` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/containers.ts src/server/opencode/runtime.ts src/server/relay/runtime.ts test/server/containers.test.ts
git commit -m "refactor: devcontainer calls address an ExecTarget (labels and an override config)"
```

### Task 3: Sessions carry the environment that runs them

**Files:**

- Modify: `src/server/status.ts`, `src/server/monitor.ts`
- Test: `test/server/status.test.ts`

**Interfaces:**

- Produces: `StatusInput.envId?: string`; `MonitorOptions.envId?: string`. `deriveSessions` sets `envId` on every session only when `input.envId` is given.

- [ ] **Step 1: Write the failing test** — add to `test/server/status.test.ts` (it already has `base` and `rawSession`):

```ts
it("tags sessions with the environment they run in, when given", () => {
  const sessions = [rawSession("ses_1")];
  expect(
    deriveSessions("p", { ...base, envId: "p-feat-0a1b", sessions })[0].envId
  ).toBe("p-feat-0a1b");
  expect(deriveSessions("p", { ...base, sessions })[0]).not.toHaveProperty(
    "envId"
  );
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/server/status.test.ts` Expected: FAIL — `expected undefined to be 'p-feat-0a1b'`.

- [ ] **Step 3: Implement** — in `src/server/status.ts`, add to `StatusInput`:

```ts
  /** The environment these sessions come from; copied onto each session. */
  envId?: string;
```

In the session object built in `deriveSessions`, after `projectId,` add:

```ts
        ...(input.envId ? { envId: input.envId } : {}),
```

In `src/server/monitor.ts`, add to `MonitorOptions` after `projectId: string;`:

```ts
  /** Copied onto every session it reports. */
  envId?: string;
```

and in `fetchAndDerive` pass it: `deriveSessions(projectId, { envId: this.opts.envId, sessions: all, active, permissions, forms, firstSeen: this.firstSeen })`.

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/server/status.test.ts test/server/monitor.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/status.ts src/server/monitor.ts test/server/status.test.ts
git commit -m "feat: sessions carry the environment that runs them"
```

### Task 4: The orchestrator's lifecycle is keyed by environment

**Files:**

- Modify: `src/server/orchestrator.ts`
- Test: `test/server/orchestrator.test.ts`

**Interfaces:**

- Consumes: `ExecTarget` (Task 2), `MonitorOptions.envId` (Task 3).
- Produces (private, used by Tasks 10–11): `interface Env { id: EnvId; project: Project; target: ExecTarget; worktree?: EnvWorktree }`; `mainEnv(project)`, `envOf(id)`, `exclusiveEnv(env, fn)`, `envDirectory(env)`, `envLog(env, line)`, `openRoute(env, c)`, `startRelay(env, ip, route)`, `forwardPorts(env, target)`, `launchOpencode(env, pw)`, `relaunchOpencode(env)`, `startMonitor(env)`, `stopContainer(env)`, `adoptRunning(env, info)`, `markStopped(env)`, `allEnvs()`, `sharedWorktrees(projectId)`, `fail(env, err)`. Maps `busy`, `monitors`, `routes`, `relayRecoveries` are keyed by `EnvId`. Public behaviour is unchanged.

- [ ] **Step 1: Write the failing test** — add to `describe("Orchestrator")`:

```ts
it("runs the main container as the project's main environment", async () => {
  const { orch, monitors } = setup();
  await orch.rescan();
  await orch.start(project.id);
  expect(monitors[0].opts).toMatchObject({
    projectId: project.id,
    envId: project.id,
    directory: "/workspaces/demo",
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run test/server/orchestrator.test.ts -t "main environment"` Expected: FAIL — `envId` is missing.

- [ ] **Step 3: Add the `Env` type and helpers** — in `src/server/orchestrator.ts`, add `EnvId` and `EnvWorktree` to the `../shared/types` import, and `type ExecTarget` to the `./containers` import. Before `export class Orchestrator`, add:

```ts
/**
 * One devcontainer with its opencode, relay, route, port forwards and monitor. A project's main
 * environment has the project's id and the project's container; a task environment serves one worktree.
 */
interface Env {
  id: EnvId;
  project: Project;
  /** What `devcontainer up` and `exec` address: the project itself for the main environment. */
  target: ExecTarget;
  /** Set on task environments. */
  worktree?: EnvWorktree;
}
```

Change the field declarations to:

```ts
  private readonly busy = new Set<EnvId>();
  private readonly monitors = new Map<EnvId, MonitorHandle>();
  …
  private readonly relayRecoveries = new Map<EnvId, number>();
  …
  private readonly routes = new Map<EnvId, Route>();
```

Add these private methods (next to `workspaceFolder`):

```ts
  private mainEnv(project: Project): Env {
    return { id: project.id, project, target: project };
  }

  private envOf(id: EnvId): Env | undefined {
    const project = this.deps.store.project(id);
    return project ? this.mainEnv(project) : undefined;
  }

  private allEnvs(): Env[] {
    return this.deps.store.projects().map((p) => this.mainEnv(p));
  }

  /** The checkout an environment's opencode serves and its monitor watches. */
  private envDirectory(env: Env): string {
    return env.worktree?.path ?? this.workspaceFolder(env.project);
  }

  /** Worktrees the main environment's opencode serves. */
  private sharedWorktrees(projectId: ProjectId): string[] {
    return (this.deps.store.runtime(projectId).worktrees ?? []).map((w) => w.path);
  }

  /** The project's log; a task environment's lines start with its branch. */
  private envLog(env: Env, raw: string): void {
    const line = cleanLogLine(raw);
    if (!line) return;
    this.log(env.project.id, env.worktree ? `[${env.worktree.branch}] ${line}` : line);
  }

  /** One lifecycle action per environment at a time; throws BusyError synchronously otherwise. */
  private exclusiveEnv<T>(env: Env, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(env.id)) throw new BusyError(env.id);
    this.busy.add(env.id);
    return fn().finally(() => this.busy.delete(env.id));
  }
```

Replace `exclusive` with:

```ts
  private exclusive(id: ProjectId, fn: (project: Project) => Promise<void>): Promise<void> {
    const project = this.deps.store.project(id);
    if (!project) throw new NotFoundError(id);
    return this.exclusiveEnv(this.mainEnv(project), () => fn(project));
  }
```

- [ ] **Step 4: Rewrite the public lifecycle methods** — replace `opencodeAddress`'s doc comment with `/** Where the host reaches an environment's opencode server while its container runs; a main environment's id is its project's. */` and change its parameter type to `EnvId`. Replace `restartOpencode`, `stop`, `adopt` and `refreshContainers` with:

```ts
  restartOpencode(id: ProjectId): Promise<void> {
    return this.exclusive(id, (p) => this.relaunchOpencode(this.mainEnv(p)));
  }

  stop(id: ProjectId): Promise<void> {
    return this.exclusive(id, (p) => this.stopContainer(this.mainEnv(p)));
  }

  async adopt(): Promise<void> {
    const { store, containers } = this.deps;
    let managed: ContainerInfo[];
    try {
      managed = await containers.listManaged();
    } catch {
      return;
    }
    for (const info of managed) {
      const project = info.projectId ? store.project(info.projectId) : undefined;
      if (!project) continue;
      const env = this.mainEnv(project);
      if (!info.running) {
        store.updateRuntime(env.id, { containerId: info.id, containerState: "stopped", opencode: "absent" });
        continue;
      }
      store.updateRuntime(env.id, {
        containerId: info.id,
        containerName: info.name,
        containerIp: info.ip,
        containerState: "running",
        worktreeRoot: this.detectWorktreeRoot(project, this.workspaceFolder(project), info),
      });
      await this.adoptRunning(env, info);
    }
  }

  async refreshContainers(): Promise<void> {
    const { store, containers } = this.deps;
    for (const env of this.allEnvs()) {
      const rt = store.runtime(env.id);
      if (this.busy.has(env.id) || rt.containerState !== "running" || !rt.containerId) continue;
      try {
        const info = await containers.inspect(rt.containerId);
        // A lifecycle action (start/stop/rebuild/...) may have started while inspect() was in
        // flight; if so it owns the environment's state now, so don't race it with a stale write.
        if (this.busy.has(env.id)) continue;
        if (info?.running) continue;
        await this.markStopped(env);
      } catch {
        // One environment's docker inspect failing shouldn't stop the others from refreshing.
      }
    }
  }
```

- [ ] **Step 5: Add the generic lifecycle helpers** — add these private methods:

```ts
  /** Route, relay, ports and opencode health of a running container found at startup. */
  private async adoptRunning(env: Env, info: ContainerInfo): Promise<void> {
    const { store, runtime } = this.deps;
    let route: Route | undefined;
    if (info.ip) {
      try {
        route = await this.openRoute(env, { id: info.id, ip: info.ip, network: info.network });
      } catch (err) {
        this.fail(env, err);
        return;
      }
      await this.forwardPorts(env, await this.startRelay(env, info.ip, route));
    }
    if (!env.worktree) await this.refreshWorktreesQuietly(env.project);
    const rt = store.runtime(env.id);
    if (route && rt.password && (await runtime.isHealthy(runtime.endpoint(route.opencode, rt.password)))) {
      store.updateRuntime(env.id, { opencode: "healthy", error: undefined });
      this.startMonitor(env);
    } else {
      store.updateRuntime(env.id, { opencode: "unhealthy", error: "opencode is not running — use Restart opencode" });
    }
  }

  /** The container went away outside opendevhub: drop what pointed at it. */
  private async markStopped(env: Env): Promise<void> {
    this.stopMonitor(env.id);
    await this.closePorts(env.id);
    await this.closeRoute(env.id);
    this.deps.store.updateRuntime(env.id, { containerState: "stopped", opencode: "absent", containerIp: undefined });
    this.deps.store.setSessions(env.id, []);
  }

  private async stopContainer(env: Env): Promise<void> {
    const { store, runtime, containers } = this.deps;
    this.stopMonitor(env.id);
    await this.closePorts(env.id);
    const rt = store.runtime(env.id);
    store.updateRuntime(env.id, { containerState: "stopping", error: undefined });
    try {
      if (rt.containerState === "running") {
        await runtime.stopServer(env.target).catch(() => {});
        await this.deps.relay.stop(env.target).catch(() => {});
      }
      if (rt.containerId) await containers.stop(rt.containerId);
      await this.closeRoute(env.id);
      store.updateRuntime(env.id, { containerState: "stopped", opencode: "absent", containerIp: undefined });
      store.setSessions(env.id, []);
    } catch (err) {
      this.fail(env, err);
    }
  }

  private async relaunchOpencode(env: Env): Promise<void> {
    const rt = this.deps.store.runtime(env.id);
    const route = this.routes.get(env.id);
    if (rt.containerState !== "running" || !rt.containerIp || !route) {
      this.fail(env, new Error("container is not running — start the project first"));
      return;
    }
    this.stopMonitor(env.id);
    this.deps.store.updateRuntime(env.id, { opencode: "starting", error: undefined });
    try {
      const relayWasActive = rt.relay === "active";
      const target = await this.startRelay(env, rt.containerIp, route);
      if (target.relay && !relayWasActive) await this.forwardPorts(env, target);
      await this.launchOpencode(env, undefined);
    } catch (err) {
      this.fail(env, err);
    }
  }
```

- [ ] **Step 6: Convert the private helpers** — replace `bringUp`, `launchOpencode`, `forwardPorts`, `openRoute`, `startRelay`, `recoverRelay`, `startMonitor` and `fail` with:

```ts
  private async bringUp(project: Project, rebuild: boolean): Promise<void> {
    const { store, containers } = this.deps;
    const env = this.mainEnv(project);
    store.updateRuntime(env.id, { containerState: "starting", opencode: "absent", error: undefined });
    try {
      const mounts = await this.worktreeMounts(project);
      const up = await containers.up(project, { rebuild, onLine: (l) => this.log(project.id, l), mounts });
      // Record the container id as soon as `up` succeeds, before the running/IP checks below can
      // throw — otherwise a container that came up but failed those checks has no containerId on
      // record, and Stop has nothing to stop.
      store.updateRuntime(env.id, { containerId: up.containerId });
      const info = await containers.inspect(up.containerId);
      if (!info?.running) throw new CommandError("container is not running after devcontainer up");
      if (!info.ip) {
        throw new CommandError("container has no bridge network IP (host networking is not supported)");
      }
      store.updateRuntime(env.id, {
        containerId: up.containerId,
        containerName: info.name,
        containerIp: info.ip,
        remoteUser: up.remoteUser,
        workspaceFolder: up.remoteWorkspaceFolder,
        worktreeRoot: this.detectWorktreeRoot(project, up.remoteWorkspaceFolder, info),
        containerState: "running",
        opencode: "starting",
      });
      const route = await this.openRoute(env, { id: up.containerId, ip: info.ip, network: info.network });
      await this.forwardPorts(env, await this.startRelay(env, info.ip, route));
      await this.refreshWorktreesQuietly(project);
      await this.launchOpencode(env, rebuild ? undefined : store.runtime(env.id).password);
    } catch (err) {
      this.fail(env, err);
    }
  }

  private async launchOpencode(env: Env, password: string | undefined): Promise<void> {
    const { store, runtime } = this.deps;
    const route = this.routes.get(env.id);
    if (!route) throw new Error("container is not running — start the project first");
    const result = await runtime.ensureRunning(env.target, {
      address: route.opencode,
      password,
      workspaceFolder: this.envDirectory(env),
      onLine: (l) => this.envLog(env, l),
    });
    store.updateRuntime(env.id, {
      password: result.password,
      opencodeVersion: result.version,
      opencode: "healthy",
      error: undefined,
    });
    this.startMonitor(env);
  }

  private async forwardPorts(env: Env, target: ForwardTarget): Promise<void> {
    const { store, containers, forwarder } = this.deps;
    let config: PortConfig;
    try {
      config = await containers.readConfiguration(env.target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.envLog(env, `ports: could not read devcontainer configuration: ${message}`);
      store.updateRuntime(env.id, { ports: [] });
      return;
    }
    const { ports, skipped } = parseForwardPorts(config.forwardPorts, config.portsAttributes);
    for (const s of skipped) this.envLog(env, `ports: skipped ${s.entry} (${s.reason})`);
    const opened = await forwarder.open(env.id, target, ports, (line) => this.envLog(env, line), {
      onRelayUnreachable: () => void this.recoverRelay(env.id),
    });
    for (const f of opened) {
      if (f.status === "forwarded") this.envLog(env, `ports: ${f.containerPort} → localhost:${f.hostPort}`);
      else if (f.status === "failed") this.envLog(env, `ports: ${f.containerPort} not forwarded (${f.reason})`);
    }
    const skippedPorts: ForwardedPort[] = skipped.map((s) => ({ status: "skipped", entry: s.entry, reason: s.reason }));
    store.updateRuntime(env.id, { ports: [...opened, ...skippedPorts] });
  }

  private async openRoute(env: Env, container: RouteContainer): Promise<Route> {
    await this.closeRoute(env.id);
    const network = this.deps.network ?? { route: async (c: RouteContainer) => directRoute(c.ip) };
    const route = await network.route(container, (line) => this.envLog(env, line));
    this.routes.set(env.id, route);
    return route;
  }

  private async startRelay(env: Env, ip: string, route: Route): Promise<ForwardTarget> {
    const { store, runtime, relay } = this.deps;
    let token = store.runtime(env.id).relayToken;
    if (!token) {
      token = generateRelayToken();
      store.updateRuntime(env.id, { relayToken: token });
    }
    const binary = await runtime.resolveBinary(env.target).catch(() => undefined);
    const result = await relay.ensureRunning(env.target, { address: route.relay, token, binary });
    const direct: ForwardTarget = route.dial ? { host: ip, dial: route.dial } : { host: ip };
    if (result.status === "active") {
      this.envLog(env, `relay: active (${result.via})`);
      store.updateRuntime(env.id, { relay: "active" });
      return { ...direct, relay: { ...route.relay, token } };
    }
    this.envLog(env, `relay: unavailable (${result.reason})`);
    store.updateRuntime(env.id, { relay: "unavailable" });
    return direct;
  }

  /** A forwarded connection found the relay gone: mark it and relaunch in the background (at most every 30 s). */
  private async recoverRelay(id: EnvId): Promise<void> {
    const now = Date.now();
    if (now - (this.relayRecoveries.get(id) ?? -Infinity) < RELAY_RECOVERY_INTERVAL_MS) return;
    this.relayRecoveries.set(id, now);
    const { store } = this.deps;
    const env = this.envOf(id);
    const rt = store.runtime(id);
    const route = this.routes.get(id);
    if (!env || this.busy.has(id) || rt.containerState !== "running" || !rt.containerIp || !route) return;
    store.updateRuntime(id, { relay: "unavailable" });
    this.envLog(env, "relay: unreachable, relaunching");
    await this.startRelay(env, rt.containerIp, route).catch(() => {});
  }

  private startMonitor(env: Env): void {
    this.stopMonitor(env.id);
    const { store, runtime, clientFor } = this.deps;
    const rt = store.runtime(env.id);
    const factory = this.deps.monitorFactory ?? ((opts: MonitorOptions) => new Monitor(opts));
    const monitor = factory({
      client: clientFor(runtime.endpoint(this.routes.get(env.id)!.opencode, rt.password!)),
      projectId: env.project.id,
      envId: env.id,
      directory: this.envDirectory(env),
      ...(env.worktree ? {} : { extraDirectories: () => this.sharedWorktrees(env.project.id) }),
      onSessions: (sessions) => {
        store.setSessions(env.id, sessions);
        this.noticeDirectories(env.project.id, [...new Set(sessions.map((s) => s.directory))]);
      },
      onHealth: (healthy) => {
        if (store.runtime(env.id).opencode === "starting") return;
        store.updateRuntime(env.id, { opencode: healthy ? "healthy" : "unhealthy" });
      },
    });
    this.monitors.set(env.id, monitor);
    monitor.start();
  }

  private fail(env: Env, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof CommandError) for (const line of err.tail) this.envLog(env, line);
    this.envLog(env, `error: ${message}`);
    const containerUp = this.deps.store.runtime(env.id).containerState === "running";
    this.deps.store.updateRuntime(env.id, {
      containerState: containerUp ? "running" : "error",
      opencode: containerUp ? "unhealthy" : "absent",
      error: message,
    });
  }
```

Change the parameter types of `closeRoute`, `closePorts`, `stopMonitor` and `opencodeClient` from `ProjectId` to `EnvId` (their bodies are unchanged). Every other caller of the old helpers passed `p.id` for a project; there are none left after this step.

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run test/server/orchestrator.test.ts && pnpm typecheck` Expected: PASS — all existing orchestrator tests plus the new one.

- [ ] **Step 8: Commit**

```bash
git add src/server/orchestrator.ts test/server/orchestrator.test.ts
git commit -m "refactor: key container lifecycle by environment, with the main environment only"
```

---

# Part B — Isolated task environments (`warmStart: "image"`)

### Task 5: `env-config` — env ids, settings, isolation blockers and the override config

**Files:**

- Create: `src/server/env-config.ts`
- Test: `test/server/env-config.test.ts`

**Interfaces:**

- Produces:
  - `envIdFor(projectId: ProjectId, worktreePath: string, branch: string): EnvId`
  - `interface EnvSettings { isolation: Isolation; keyFiles: string[] }`, `resolveEnvSettings(custom: unknown, override: unknown): EnvSettings`
  - `LIFECYCLE_KEYS`, `isolationBlocker(config: Record<string, unknown>, guessedFolder?: string): string | undefined`
  - `interface OverrideInput { config; guessedFolder?; image; worktree: { hostPath; path }; gitDir: { host; container } }`, `buildOverrideConfig(input): { config: Record<string, unknown>; notes: string[] }`

- [ ] **Step 1: Write the failing tests** — `test/server/env-config.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  buildOverrideConfig,
  envIdFor,
  isolationBlocker,
  resolveEnvSettings,
} from "../../src/server/env-config";

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

describe("envIdFor", () => {
  it("is the project id, a branch slug and a short hash", () => {
    expect(
      envIdFor(
        "demo-abc123",
        "/workspaces/demo.worktrees/feature-login",
        "feature/login"
      )
    ).toMatch(/^demo-abc123-feature-login-[0-9a-f]{4}$/);
  });
  it("differs per worktree and is stable", () => {
    const a = envIdFor("demo-abc123", "/w/demo.worktrees/a", "x");
    expect(envIdFor("demo-abc123", "/w/demo.worktrees/a", "x")).toBe(a);
    expect(envIdFor("demo-abc123", "/w/demo.worktrees/b", "x")).not.toBe(a);
  });
  it("fits a DNS label even for long names", () => {
    const id = envIdFor(
      `${"a".repeat(50)}-abc123`,
      "/w/x",
      "a-very-long-branch-name-that-goes-on"
    );
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(LABEL);
  });
  it("names a branch with no usable characters 'worktree'", () => {
    expect(envIdFor("demo-abc123", "/w/x", "___")).toMatch(
      /^demo-abc123-worktree-[0-9a-f]{4}$/
    );
  });
});

describe("resolveEnvSettings", () => {
  it("defaults to shared with no key files", () => {
    expect(resolveEnvSettings(undefined, undefined)).toEqual({
      isolation: "shared",
      keyFiles: [],
    });
  });
  it("reads the devcontainer customization, and the config.json override wins", () => {
    expect(
      resolveEnvSettings(
        { isolation: "isolated", keyFiles: ["package-lock.json"] },
        undefined
      )
    ).toEqual({ isolation: "isolated", keyFiles: ["package-lock.json"] });
    expect(
      resolveEnvSettings({ isolation: "isolated" }, { isolation: "shared" })
        .isolation
    ).toBe("shared");
    expect(
      resolveEnvSettings({ keyFiles: ["a"] }, { keyFiles: ["b"] }).keyFiles
    ).toEqual(["b"]);
  });
  it("ignores invalid values and unsafe key files", () => {
    expect(
      resolveEnvSettings(
        {
          isolation: "yes",
          keyFiles: ["ok.lock", "/etc/passwd", "../x", "-x", 3, "a b"],
        },
        null
      )
    ).toEqual({ isolation: "shared", keyFiles: ["ok.lock"] });
  });
});

describe("isolationBlocker", () => {
  it.each([
    [{ dockerComposeFile: "compose.yml" }, /Docker Compose/],
    [{ appPort: 3000 }, /appPort/],
    [{ runArgs: ["-p", "3000:3000"] }, /publish host ports/],
    [{ runArgs: ["-p3000:3000"] }, /publish host ports/],
    [{ runArgs: ["--publish=3000:3000"] }, /publish host ports/],
    [{ runArgs: ["-P"] }, /publish host ports/],
    [{ runArgs: ["--network=host"] }, /host networking/],
    [{ runArgs: ["--net", "host"] }, /host networking/],
  ])("refuses %j", (config, reason) => {
    expect(isolationBlocker(config)).toMatch(reason);
  });
  it("accepts ordinary configs", () => {
    expect(
      isolationBlocker({
        image: "node",
        runArgs: ["--privileged", "--cap-add=SYS_PTRACE"],
      })
    ).toBeUndefined();
  });
  it("refuses lifecycle commands that use the workspace folder the CLI guessed", () => {
    expect(
      isolationBlocker(
        { postCreateCommand: "cd /workspaces/feat && npm ci" },
        "/workspaces/feat"
      )
    ).toMatch(/containerWorkspaceFolder/);
    expect(
      isolationBlocker(
        { postCreateCommand: "cd /workspaces/feature && npm ci" },
        "/workspaces/feat"
      )
    ).toBeUndefined();
  });
});

describe("buildOverrideConfig", () => {
  const base = {
    guessedFolder: "/workspaces/feat",
    image: "opendevhub/demo-abc123:0123456789ab-base",
    worktree: {
      hostPath: "/src/demo.worktrees/feat",
      path: "/workspaces/demo.worktrees/feat",
    },
    gitDir: { host: "/src/demo/.git", container: "/workspaces/demo/.git" },
  };

  it("pins the image and drops what the image already carries", () => {
    const { config } = buildOverrideConfig({
      ...base,
      config: {
        name: "demo",
        build: { dockerfile: "Dockerfile" },
        features: { "ghcr.io/x/y:1": {} },
        initializeCommand: "echo host",
        onCreateCommand: "a",
        updateContentCommand: "b",
        postCreateCommand: "c",
        postStartCommand: "d",
        postAttachCommand: "e",
        forwardPorts: [3000],
        configFilePath: { fsPath: "/x" },
      },
    });
    expect(config).toEqual({
      name: "demo",
      initializeCommand: "echo host",
      forwardPorts: [3000],
      image: base.image,
      workspaceMount:
        "type=bind,source=/src/demo.worktrees/feat,target=/workspaces/demo.worktrees/feat",
      workspaceFolder: "/workspaces/demo.worktrees/feat",
      mounts: ["type=bind,source=/src/demo/.git,target=/workspaces/demo/.git"],
    });
  });

  it("keeps the original mounts and adds .git", () => {
    const { config } = buildOverrideConfig({
      ...base,
      config: { image: "node", mounts: ["type=volume,source=c,target=/cache"] },
    });
    expect(config.mounts).toEqual([
      "type=volume,source=c,target=/cache",
      "type=bind,source=/src/demo/.git,target=/workspaces/demo/.git",
    ]);
  });

  it("removes --name from runArgs and says so", () => {
    const { config, notes } = buildOverrideConfig({
      ...base,
      config: {
        image: "node",
        runArgs: ["--name", "demo", "--init", "--name=x"],
      },
    });
    expect(config.runArgs).toEqual(["--init"]);
    expect(notes).toEqual([
      "removed --name from runArgs: every task container needs its own name",
    ]);
  });

  it("points paths the CLI guessed at the worktree", () => {
    const { config } = buildOverrideConfig({
      ...base,
      config: {
        image: "node",
        containerEnv: {
          BIN: "/workspaces/feat/bin",
          OTHER: "/workspaces/feature",
          ROOT: "/workspaces/feat",
        },
      },
    });
    expect(config.containerEnv).toEqual({
      BIN: "/workspaces/demo.worktrees/feat/bin",
      OTHER: "/workspaces/feature",
      ROOT: "/workspaces/demo.worktrees/feat",
    });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/server/env-config.test.ts` Expected: FAIL — cannot find module `../../src/server/env-config`.

- [ ] **Step 3: Implement** — `src/server/env-config.ts`:

```ts
import { createHash } from "node:crypto";

import { slugify } from "../shared/tasks";
import type { EnvId, Isolation, ProjectId } from "../shared/types";

const MAX_LABEL = 63;
const BRANCH_SLUG_MAX = 20;

/** `<projectId>-<branch slug>-<hash4>`, at most 63 characters so it works as a hostname label. */
export function envIdFor(
  projectId: ProjectId,
  worktreePath: string,
  branch: string
): EnvId {
  const hash = createHash("sha256")
    .update(`${projectId}\0${worktreePath}`)
    .digest("hex")
    .slice(0, 4);
  const tail = `-${slugify(branch, BRANCH_SLUG_MAX) || "worktree"}-${hash}`;
  return projectId.slice(0, MAX_LABEL - tail.length).replace(/-+$/, "") + tail;
}

export interface EnvSettings {
  isolation: Isolation;
  /** Files whose change invalidates the image, relative to the repository root. */
  keyFiles: string[];
}

const KEY_FILE = /^[\w.@+][\w.@+/-]*$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** `customizations.opendevhub` from devcontainer.json, with the project's `config.json` entry taking precedence. */
export function resolveEnvSettings(
  custom: unknown,
  override: unknown
): EnvSettings {
  const c = record(custom);
  const o = record(override);
  const isolation =
    [o.isolation, c.isolation].find(
      (v): v is Isolation => v === "shared" || v === "isolated"
    ) ?? "shared";
  const files = Array.isArray(o.keyFiles)
    ? o.keyFiles
    : Array.isArray(c.keyFiles)
      ? c.keyFiles
      : [];
  return {
    isolation,
    keyFiles: files.filter(
      (f): f is string =>
        typeof f === "string" &&
        KEY_FILE.test(f) &&
        !f.split("/").includes("..")
    ),
  };
}

export const LIFECYCLE_KEYS = [
  "onCreateCommand",
  "updateContentCommand",
  "postCreateCommand",
  "postStartCommand",
  "postAttachCommand",
] as const;

/** Keys that describe how to build the image; the pinned image already carries their result in its label. */
const IMAGE_KEYS = [
  "image",
  "build",
  "dockerFile",
  "context",
  "dockerComposeFile",
  "service",
  "runServices",
  "features",
  "overrideFeatureInstallOrder",
];

const PUBLISH = /^(-p|-P$|--publish(-all)?(=|$))/;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches `folder` as a whole path or a path prefix, not as the start of a longer name. */
function folderPattern(folder: string): RegExp {
  return new RegExp(`${escapeRegExp(folder)}(?=$|[^\\w.-])`, "g");
}

/** Why this config can't run one container per worktree; undefined when it can. */
export function isolationBlocker(
  config: Record<string, unknown>,
  guessedFolder?: string
): string | undefined {
  if (config.dockerComposeFile !== undefined)
    return "Docker Compose configurations can't run in their own container yet";
  if (config.appPort !== undefined)
    return "appPort publishes host ports, which several containers can't share";
  const args = Array.isArray(config.runArgs)
    ? config.runArgs.filter((a): a is string => typeof a === "string")
    : [];
  if (args.some((a) => PUBLISH.test(a)))
    return "runArgs publish host ports (-p/--publish), which several containers can't share";
  if (
    args.some(
      (a, i) =>
        /^--net(work)?=host$/.test(a) ||
        (/^--net(work)?$/.test(a) && args[i + 1] === "host")
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
}

function replaceFolder(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.replace(folderPattern(from), to);
  if (Array.isArray(value)) return value.map((v) => replaceFolder(v, from, to));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, replaceFolder(v, from, to)])
    );
  }
  return value;
}

function withoutName(args: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") i++;
    else if (
      typeof args[i] === "string" &&
      (args[i] as string).startsWith("--name=")
    )
      continue;
    else out.push(args[i]);
  }
  return out;
}

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
export function buildOverrideConfig(input: OverrideInput): {
  config: Record<string, unknown>;
  notes: string[];
} {
  const notes: string[] = [];
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.config)) {
    if (
      key === "configFilePath" ||
      IMAGE_KEYS.includes(key) ||
      (LIFECYCLE_KEYS as readonly string[]).includes(key)
    )
      continue;
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
    if (kept.length !== config.runArgs.length)
      notes.push(
        "removed --name from runArgs: every task container needs its own name"
      );
    config.runArgs = kept;
  }
  return { config, notes };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/server/env-config.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/env-config.ts test/server/env-config.test.ts
git commit -m "feat: env ids, isolation settings and the task container's override config"
```

### Task 6: Per-project overrides, the state folder and override config files

**Files:**

- Modify: `src/server/config.ts`
- Create: `src/server/env-files.ts`
- Test: `test/server/config.test.ts`, `test/server/env-files.test.ts`

**Interfaces:**

- Produces: `Config.projects?: Record<string, unknown>` (keyed by project path); `stateDir(env?): string`; `PersistedEnv`, `PersistedState.environments?` (used in Task 9); `class EnvFiles { path(envId): string; write(envId, config): Promise<string>; remove(envId): Promise<void> }`.

- [ ] **Step 1: Write the failing tests** — add to `test/server/config.test.ts` (import `stateDir` too):

```ts
describe("config projects", () => {
  it("keeps per-project settings through the CLI's load and save", () => {
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({
        roots: [],
        port: 1,
        projects: { "/src/demo": { isolation: "isolated" } },
      })
    );
    saveConfig(dir, loadConfig(dir));
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"))
        .projects
    ).toEqual({ "/src/demo": { isolation: "isolated" } });
  });
});

describe("stateDir", () => {
  it("uses XDG_STATE_HOME when absolute, else ~/.local/state", () => {
    expect(stateDir({ XDG_STATE_HOME: "/xdg" })).toBe("/xdg/opendevhub");
    expect(stateDir({ XDG_STATE_HOME: "rel" })).toBe(
      path.join(os.homedir(), ".local", "state", "opendevhub")
    );
  });
});

describe("persisted environments", () => {
  it("round-trips task environments in state.json", () => {
    const state = {
      projects: {},
      environments: {
        "demo-feat-0a1b": {
          projectId: "demo",
          worktree: {
            path: "/w/demo.worktrees/feat",
            hostPath: "/src/demo.worktrees/feat",
            branch: "feat",
          },
          containerId: "c2",
        },
      },
    };
    saveState(dir, state);
    expect(loadState(dir)).toEqual(state);
  });
});
```

`test/server/env-files.test.ts`:

```ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EnvFiles } from "../../src/server/env-files";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-envs-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("EnvFiles", () => {
  it("writes, locates and removes an environment's config", async () => {
    const files = new EnvFiles(dir);
    const file = await files.write("demo-feat-0a1b", { image: "x" });
    expect(file).toBe(path.join(dir, "demo-feat-0a1b", "devcontainer.json"));
    expect(files.path("demo-feat-0a1b")).toBe(file);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ image: "x" });
    await files.remove("demo-feat-0a1b");
    expect(fs.existsSync(path.join(dir, "demo-feat-0a1b"))).toBe(false);
  });
  it("refuses ids that aren't env ids", () => {
    expect(() => new EnvFiles(dir).path("../x")).toThrow(
      /invalid environment id/
    );
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/server/config.test.ts test/server/env-files.test.ts` Expected: FAIL — `projects` is dropped, `stateDir` and `EnvFiles` don't exist.

- [ ] **Step 3: Implement `config.ts`** — add `EnvId` and `EnvWorktree` to the shared-types import. Add to `Config`:

```ts
  /** Per-project settings keyed by the project's path (`{ isolation, keyFiles }`), validated where used. */
  projects?: Record<string, unknown>;
```

Add after `PersistedRuntime`:

```ts
/** A task environment as state.json keeps it. */
export interface PersistedEnv extends PersistedRuntime {
  projectId: ProjectId;
  worktree: EnvWorktree;
  image?: { key: string; ref: string };
}
```

and to `PersistedState`: `environments?: Record<EnvId, PersistedEnv>;`.

In `loadConfig`'s return, after the forges spread:

```ts
    ...(raw.projects && typeof raw.projects === "object" && !Array.isArray(raw.projects) ? { projects: raw.projects } : {}),
```

Replace `loadState`:

```ts
export function loadState(dir: string): PersistedState {
  const raw = readJson<Partial<PersistedState>>(
    path.join(dir, "state.json"),
    {}
  );
  const environments =
    raw.environments && typeof raw.environments === "object"
      ? raw.environments
      : undefined;
  return {
    projects:
      raw.projects && typeof raw.projects === "object" ? raw.projects : {},
    ...(environments ? { environments } : {}),
  };
}
```

Add after `configDir`:

```ts
/** Where opendevhub keeps generated files: `$XDG_STATE_HOME/opendevhub`, default `~/.local/state/opendevhub`. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = env.XDG_STATE_HOME;
  const base =
    xdg && path.isAbsolute(xdg)
      ? xdg
      : path.join(os.homedir(), ".local", "state");
  return path.join(base, "opendevhub");
}
```

- [ ] **Step 4: Implement `env-files.ts`**:

```ts
import fs from "node:fs/promises";
import path from "node:path";

import type { EnvId } from "../shared/types";

const ENV_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The generated devcontainer.json of each task environment, one folder per environment. */
export class EnvFiles {
  constructor(private readonly dir: string) {}

  path(envId: EnvId): string {
    return path.join(this.folder(envId), "devcontainer.json");
  }

  async write(envId: EnvId, config: Record<string, unknown>): Promise<string> {
    const file = this.path(envId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n");
    return file;
  }

  async remove(envId: EnvId): Promise<void> {
    await fs.rm(this.folder(envId), { recursive: true, force: true });
  }

  private folder(envId: EnvId): string {
    if (!ENV_ID.test(envId)) throw new Error(`invalid environment id ${envId}`);
    return path.join(this.dir, envId);
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run test/server/config.test.ts test/server/env-files.test.ts test/server/cli.test.ts` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/config.ts src/server/env-files.ts test/server/config.test.ts test/server/env-files.test.ts
git commit -m "feat: per-project settings in config.json, the state folder and override config files"
```

### Task 7: Containers and git for task environments

**Files:**

- Modify: `src/server/containers.ts`, `src/server/git.ts`
- Test: `test/server/containers.test.ts`, `test/server/git.test.ts`

**Interfaces:**

- Produces: `ENV_LABEL = "opendevhub.env"`, `ENV_PROJECT_LABEL = "opendevhub.env-project"`, `envLabels(envId, projectId): string[]`; `ContainerInfo.envId?`, `ContainerInfo.envProjectId?`, `ContainerInfo.image?` (and `projectId` is set from `opendevhub.project` only); `PortConfig.configuration?: Record<string, unknown>`; `Containers.listManaged()` returns both kinds; `readConfig(folder): Promise<{ configuration: Record<string, unknown>; workspaceFolder?: string }>`; `build(folder, imageName, onLine): Promise<void>`; `imageExists(ref): Promise<boolean>`; `remove(containerId): Promise<void>`; `removeImage(ref): Promise<boolean>`; `GitOps.headObjects(p, dir, paths): Promise<(string | undefined)[]>`.

- [ ] **Step 1: Write the failing tests** — add to `test/server/containers.test.ts` (import `ENV_LABEL`, `ENV_PROJECT_LABEL`, `envLabels`, `parseInspect`):

```ts
describe("task environment containers", () => {
  const taskInspect = JSON.stringify({
    Id: "def456",
    Name: "/task",
    State: { Running: true },
    Config: {
      Image: "vsc-feat-1234-uid",
      Labels: {
        [ENV_LABEL]: "demo-1a2b3c-feat-0a1b",
        [ENV_PROJECT_LABEL]: "demo-1a2b3c",
      },
    },
    NetworkSettings: { Networks: { bridge: { IPAddress: "172.17.0.6" } } },
  });

  it("reads a task container's labels without making it look like a project's", () => {
    const info = parseInspect(taskInspect);
    expect(info).toMatchObject({
      id: "def456",
      envId: "demo-1a2b3c-feat-0a1b",
      envProjectId: "demo-1a2b3c",
      image: "vsc-feat-1234-uid",
    });
    expect(info.projectId).toBeUndefined();
  });

  it("labels task containers with their environment and project", () => {
    expect(envLabels("e", "p")).toEqual([
      `${ENV_LABEL}=e`,
      `${ENV_PROJECT_LABEL}=p`,
    ]);
  });

  it("lists project and task containers", async () => {
    const { run, calls } = fakeRunner(({ args }) => {
      if (args[0] === "ps")
        return {
          stdout: args.includes(`label=${LABEL}`) ? "abc123\n" : "def456\n",
        };
      return { stdout: args.at(-1) === "abc123" ? inspectJson : taskInspect };
    });
    const list = await new Containers(run).listManaged();
    expect(list.map((c) => c.id)).toEqual(["abc123", "def456"]);
    expect(calls.filter((c) => c.args[0] === "ps").map((c) => c.args)).toEqual([
      ["ps", "-a", "--filter", `label=${LABEL}`, "--format", "{{.ID}}"],
      ["ps", "-a", "--filter", `label=${ENV_LABEL}`, "--format", "{{.ID}}"],
    ]);
  });

  it("reads a folder's configuration and the workspace folder the CLI would use", async () => {
    const stdout = JSON.stringify({
      configuration: { image: "node", configFilePath: { fsPath: "/x" } },
      workspace: { workspaceFolder: "/workspaces/feat" },
    });
    const { run, calls } = fakeRunner(() => ({ stdout }));
    expect(
      await new Containers(run).readConfig("/src/demo.worktrees/feat")
    ).toEqual({
      configuration: { image: "node" },
      workspaceFolder: "/workspaces/feat",
    });
    expect(calls[0].args).toEqual([
      "read-configuration",
      "--workspace-folder",
      "/src/demo.worktrees/feat",
    ]);
  });

  it("builds an image and reports the CLI's error", async () => {
    const ok = fakeRunner(() => ({
      stdout: '{"outcome":"success","imageName":["img"]}\n',
    }));
    await new Containers(ok.run).build("/f", "img", () => {});
    expect(ok.calls[0].args).toEqual([
      "build",
      "--workspace-folder",
      "/f",
      "--image-name",
      "img",
    ]);
    const bad = fakeRunner(() => ({
      exitCode: 1,
      stdout: '{"outcome":"error","message":"no Dockerfile"}\n',
      stderr: "boom",
    }));
    await expect(
      new Containers(bad.run).build("/f", "img", () => {})
    ).rejects.toThrow(/devcontainer build failed: no Dockerfile/);
  });

  it("checks for an image, removes containers (a missing one is fine) and removes images", async () => {
    const { run, calls } = fakeRunner(({ args }) => {
      if (args[0] === "image" && args[1] === "inspect")
        return { exitCode: args.at(-1) === "there" ? 0 : 1 };
      if (args[0] === "rm" && args.at(-1) === "gone")
        return { exitCode: 1, stderr: "Error: No such container: gone" };
      return {};
    });
    const c = new Containers(run);
    expect(await c.imageExists("there")).toBe(true);
    expect(await c.imageExists("missing")).toBe(false);
    await c.remove("gone");
    await c.remove("c2");
    expect(calls.at(-1)?.args).toEqual(["rm", "-f", "c2"]);
    expect(await c.removeImage("img")).toBe(true);
    expect(calls.at(-1)?.args).toEqual(["image", "rm", "img"]);
  });

  it("returns the raw configuration with the port settings", async () => {
    const stdout = JSON.stringify({
      configuration: {
        customizations: { opendevhub: { isolation: "isolated" } },
      },
      mergedConfiguration: { forwardPorts: [3000] },
    });
    const { run } = fakeRunner(() => ({ stdout }));
    const cfg = await new Containers(run).readConfiguration(project);
    expect(cfg.forwardPorts).toEqual([3000]);
    expect(cfg.configuration).toEqual({
      customizations: { opendevhub: { isolation: "isolated" } },
    });
  });
});
```

Add to `test/server/git.test.ts` (outside the real-repo `describe`, with `vi` imported from vitest):

```ts
describe("headObjects", () => {
  it("returns the object id of each path at HEAD, undefined where it is missing", async () => {
    const exec = vi.fn(
      async (_p: Project, _cmd: string[], _o?: { timeoutMs?: number }) => ({
        exitCode: 0,
        stdout: "aaa\n-\nbbb\n",
        stderr: "",
        timedOut: false,
      })
    );
    const ops = new GitOps({ containers: { exec } });
    expect(
      await ops.headObjects(project, "/w/x", [
        ".devcontainer",
        ".devcontainer.json",
        "package-lock.json",
      ])
    ).toEqual(["aaa", undefined, "bbb"]);
    expect(exec.mock.calls[0][1].slice(0, 2)).toEqual(["sh", "-c"]);
    expect(exec.mock.calls[0][1].slice(3)).toEqual([
      "sh",
      "/w/x",
      ".devcontainer",
      ".devcontainer.json",
      "package-lock.json",
    ]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/server/containers.test.ts test/server/git.test.ts` Expected: FAIL — missing exports and methods.

- [ ] **Step 3: Implement `containers.ts`** — after `LABEL`:

```ts
/** Task containers carry these instead of LABEL, so a project's own lookups never find them. */
export const ENV_LABEL = "opendevhub.env";
export const ENV_PROJECT_LABEL = "opendevhub.env-project";

export function envLabels(envId: string, projectId: string): string[] {
  return [`${ENV_LABEL}=${envId}`, `${ENV_PROJECT_LABEL}=${projectId}`];
}
```

Add to `PortConfig`: `/** The devcontainer.json as read, before features and the image label are merged in. */ configuration?: Record<string, unknown>;`. In `readConfiguration`, change the `parsed` type to keep `configuration`, and return `configuration: parsed.configuration` with the ports.

Add to `ContainerInfo`:

```ts
  /** Set on task containers. */
  envId?: string;
  envProjectId?: string;
  /** The image it was created from. */
  image?: string;
```

In `parseInspect`, add `Image?: string` to `Config`'s type, and build `info` with:

```ts
    projectId: c.Config?.Labels?.[LABEL],
    envId: c.Config?.Labels?.[ENV_LABEL],
    envProjectId: c.Config?.Labels?.[ENV_PROJECT_LABEL],
    image: c.Config?.Image,
```

Then delete any of those three env/image keys that are `undefined` (`for (const k of ["envId", "envProjectId", "image"] as const) if (info[k] === undefined) delete info[k];`) so existing `toEqual` assertions on main containers keep passing.

Add a helper above `class Containers`:

```ts
/** The last `{"outcome": …}` line the devcontainer CLI printed. */
function lastOutcome(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
      if (typeof parsed.outcome === "string") return parsed;
    } catch {
      // not JSON
    }
  }
  return undefined;
}
```

Replace `listManaged` and add the new methods:

```ts
  async listManaged(): Promise<ContainerInfo[]> {
    const ids: string[] = [];
    for (const label of [LABEL, ENV_LABEL]) {
      const r = await this.run("docker", ["ps", "-a", "--filter", `label=${label}`, "--format", "{{.ID}}"], {
        timeoutMs: DOCKER_TIMEOUT_MS,
      });
      if (r.exitCode !== 0) throw new CommandError(`docker ps failed: ${r.stderr.trim()}`, tailLines(r.stderr));
      for (const id of r.stdout.split(/\s+/).filter(Boolean)) if (!ids.includes(id)) ids.push(id);
    }
    const infos = await Promise.all(ids.map((id) => this.inspect(id)));
    return infos.filter((i): i is ContainerInfo => i !== undefined);
  }

  /** The devcontainer.json a folder would use, with the CLI's variables filled in, and where it would mount the folder. */
  async readConfig(folder: string): Promise<{ configuration: Record<string, unknown>; workspaceFolder?: string }> {
    const r = await this.run("devcontainer", ["read-configuration", "--workspace-folder", folder], { timeoutMs: 60_000 });
    if (r.exitCode !== 0) {
      throw new CommandError(`devcontainer read-configuration failed (exit ${r.exitCode})`, tailLines(r.stderr));
    }
    let parsed: { configuration?: Record<string, unknown>; workspace?: { workspaceFolder?: unknown } };
    try {
      parsed = JSON.parse(r.stdout.trim()) as typeof parsed;
    } catch {
      throw new CommandError("devcontainer read-configuration returned invalid JSON", tailLines(r.stdout));
    }
    const { configFilePath: _file, ...configuration } = parsed.configuration ?? {};
    const workspaceFolder = parsed.workspace?.workspaceFolder;
    return { configuration, ...(typeof workspaceFolder === "string" ? { workspaceFolder } : {}) };
  }

  /** Builds the image a folder's config describes (Dockerfile and features), without a container or lifecycle commands. */
  async build(folder: string, imageName: string, onLine: (line: string) => void): Promise<void> {
    const r = await this.run("devcontainer", ["build", "--workspace-folder", folder, "--image-name", imageName], {
      timeoutMs: UP_TIMEOUT_MS,
      onLine,
    });
    const outcome = lastOutcome(r.stdout);
    if (r.exitCode === 0 && outcome?.outcome === "success") return;
    const reason = outcome?.message ?? outcome?.description ?? (r.timedOut ? "timed out after 15 minutes" : `exit ${r.exitCode}`);
    throw new CommandError(`devcontainer build failed: ${String(reason)}`, tailLines(`${r.stderr}\n${r.stdout}`));
  }

  async imageExists(ref: string): Promise<boolean> {
    const r = await this.run("docker", ["image", "inspect", "--format", "{{.Id}}", ref], { timeoutMs: DOCKER_TIMEOUT_MS });
    return r.exitCode === 0;
  }

  /** Removes a container, stopping it first. One that is already gone counts as removed. */
  async remove(containerId: string): Promise<void> {
    const r = await this.run("docker", ["rm", "-f", containerId], { timeoutMs: 30_000 });
    if (r.exitCode !== 0 && !/No such container/i.test(r.stderr)) {
      throw new CommandError(`docker rm failed: ${r.stderr.trim()}`, tailLines(r.stderr));
    }
  }

  /** Best effort: false when the image is in use or gone. */
  async removeImage(ref: string): Promise<boolean> {
    const r = await this.run("docker", ["image", "rm", ref], { timeoutMs: 30_000 });
    return r.exitCode === 0;
  }
```

- [ ] **Step 4: Implement `GitOps.headObjects`** — in `src/server/git.ts`, add to `GitOps`:

```ts
  /** The object id of each path at HEAD (a tree for folders, a blob for files); undefined where it doesn't exist. */
  async headObjects(p: Project, dir: string, paths: string[]): Promise<(string | undefined)[]> {
    const script = 'd="$1"; shift; for p in "$@"; do git -C "$d" rev-parse --verify --quiet "HEAD:$p" || echo -; done';
    const r = await this.deps.containers.exec(p, ["sh", "-c", script, "sh", dir, ...paths], { timeoutMs: GIT_TIMEOUT_MS });
    if (r.exitCode !== 0) throw failure(["rev-parse"], r);
    const lines = r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    return paths.map((_, i) => (lines[i] && lines[i] !== "-" ? lines[i] : undefined));
  }
```

- [ ] **Step 5: Run the tests**

Run: `pnpm vitest run test/server/containers.test.ts test/server/git.test.ts && pnpm typecheck` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/containers.ts src/server/git.ts test/server/containers.test.ts test/server/git.test.ts
git commit -m "feat: task container labels, image build and removal, and object ids at HEAD"
```

### Task 8: `Images` — one base image per project and image key

**Files:**

- Create: `src/server/images.ts`
- Test: `test/server/images.test.ts`

**Interfaces:**

- Consumes: `Containers.imageExists/build`, `GitOps.headObjects` (Task 7).
- Produces: `KEY_PATHS`, `imageKey({ cliVersion, objects, generation }): string` (64 hex), `baseImageRef(projectId, key): string`, `class Images { ensureBase(project, worktree: EnvWorktree, keyFiles: string[], onLine): Promise<{ key: string; ref: string }> }`.

- [ ] **Step 1: Write the failing tests** — `test/server/images.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

import type { RunResult } from "../../src/server/exec";
import { Images, baseImageRef, imageKey } from "../../src/server/images";
import type { EnvWorktree, Project } from "../../src/shared/types";

const project: Project = {
  id: "demo-abc123",
  name: "demo",
  path: "/src/demo",
  devcontainerPath: "/x",
};
const other: Project = { ...project, id: "other-def456", path: "/src/other" };
const wt = (name: string): EnvWorktree => ({
  path: `/workspaces/demo.worktrees/${name}`,
  hostPath: `/src/demo.worktrees/${name}`,
  branch: name,
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function setup(objects: (string | undefined)[] = ["tree1", undefined]) {
  const builds: Array<{
    folder: string;
    ref: string;
    done: ReturnType<typeof deferred>;
  }> = [];
  const containers = {
    imageExists: vi.fn(async (_ref: string) => false),
    build: vi.fn(
      (folder: string, ref: string, _onLine: (l: string) => void) => {
        const done = deferred();
        builds.push({ folder, ref, done });
        return done.promise;
      }
    ),
  };
  const git = {
    headObjects: vi.fn(
      async (_p: Project, _dir: string, _paths: string[]) => objects
    ),
  };
  const run = vi.fn(async (): Promise<RunResult> => ({
    exitCode: 0,
    stdout: "0.89.0\n",
    stderr: "",
    timedOut: false,
  }));
  return {
    images: new Images({ run, containers, git }),
    containers,
    git,
    builds,
    run,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("imageKey", () => {
  it("changes with each input", () => {
    const k = imageKey({
      cliVersion: "0.89.0",
      objects: ["a", undefined],
      generation: 0,
    });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(
      imageKey({
        cliVersion: "0.90.0",
        objects: ["a", undefined],
        generation: 0,
      })
    ).not.toBe(k);
    expect(
      imageKey({
        cliVersion: "0.89.0",
        objects: ["b", undefined],
        generation: 0,
      })
    ).not.toBe(k);
    expect(
      imageKey({
        cliVersion: "0.89.0",
        objects: [undefined, "a"],
        generation: 0,
      })
    ).not.toBe(k);
    expect(
      imageKey({
        cliVersion: "0.89.0",
        objects: ["a", undefined],
        generation: 1,
      })
    ).not.toBe(k);
  });
  it("names the base image after the project and the key", () => {
    expect(baseImageRef("demo-abc123", "0123456789abcdef")).toBe(
      "opendevhub/demo-abc123:0123456789ab-base"
    );
  });
});

describe("Images.ensureBase", () => {
  it("reads the key inputs at the worktree's HEAD, with the key files", async () => {
    const { images, git, builds } = setup();
    const p = images.ensureBase(
      project,
      wt("a"),
      ["package-lock.json"],
      () => {}
    );
    await tick();
    builds[0].done.resolve();
    const { key, ref } = await p;
    expect(git.headObjects).toHaveBeenCalledWith(
      project,
      "/workspaces/demo.worktrees/a",
      [".devcontainer", ".devcontainer.json", "package-lock.json"]
    );
    expect(ref).toBe(baseImageRef(project.id, key));
    expect(builds[0].folder).toBe("/src/demo.worktrees/a");
  });

  it("builds a missing image once for concurrent tasks that need it", async () => {
    const { images, containers, builds } = setup();
    const a = images.ensureBase(project, wt("a"), [], () => {});
    const b = images.ensureBase(project, wt("b"), [], () => {});
    await tick();
    expect(containers.build).toHaveBeenCalledTimes(1);
    builds[0].done.resolve();
    expect((await a).ref).toBe((await b).ref);
  });

  it("skips the build when the image exists", async () => {
    const { images, containers } = setup();
    containers.imageExists.mockResolvedValue(true);
    await images.ensureBase(project, wt("a"), [], () => {});
    expect(containers.build).not.toHaveBeenCalled();
  });

  it("builds one image at a time per project, and other projects in parallel", async () => {
    const { images, git, builds } = setup();
    git.headObjects.mockImplementation(async (_p: Project, dir: string) => [
      dir,
    ]);
    const a = images.ensureBase(project, wt("a"), [], () => {});
    const b = images.ensureBase(project, wt("b"), [], () => {});
    const c = images.ensureBase(other, wt("c"), [], () => {});
    await tick();
    expect(builds.map((x) => x.folder)).toEqual([
      "/src/demo.worktrees/a",
      "/src/demo.worktrees/c",
    ]);
    builds[0].done.resolve();
    await a;
    await tick();
    expect(builds.map((x) => x.folder)).toContain("/src/demo.worktrees/b");
    for (const x of builds) x.done.resolve();
    await Promise.all([b, c]);
  });

  it("lets the next request retry after a failed build", async () => {
    const { images, containers } = setup();
    containers.build.mockRejectedValueOnce(new Error("boom"));
    await expect(
      images.ensureBase(project, wt("a"), [], () => {})
    ).rejects.toThrow("boom");
    containers.build.mockResolvedValueOnce(undefined);
    await expect(
      images.ensureBase(project, wt("a"), [], () => {})
    ).resolves.toMatchObject({ key: expect.any(String) });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/server/images.test.ts` Expected: FAIL — cannot find module `../../src/server/images`.

- [ ] **Step 3: Implement** — `src/server/images.ts`:

```ts
import { createHash } from "node:crypto";

import type { EnvWorktree, Project } from "../shared/types";
import type { Containers } from "./containers";
import type { Runner } from "./exec";
import type { GitOps } from "./git";

/** What a config's image depends on, besides the key files a project lists. */
export const KEY_PATHS = [".devcontainer", ".devcontainer.json"];

export function imageKey(input: {
  cliVersion: string;
  objects: (string | undefined)[];
  generation: number;
}): string {
  const parts = [
    input.cliVersion,
    input.objects.map((o) => o ?? null),
    input.generation,
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function baseImageRef(projectId: string, key: string): string {
  return `opendevhub/${projectId}:${key.slice(0, 12)}-base`;
}

export interface ImagesDeps {
  run: Runner;
  containers: Pick<Containers, "imageExists" | "build">;
  git: Pick<GitOps, "headObjects">;
}

/** Base images for task environments: one per project and image key, built one at a time per project. */
export class Images {
  private cli?: Promise<string>;
  private readonly building = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ImagesDeps) {}

  /** The image a worktree's config describes, built first when it doesn't exist yet. */
  async ensureBase(
    project: Project,
    worktree: EnvWorktree,
    keyFiles: string[],
    onLine: (line: string) => void
  ): Promise<{ key: string; ref: string }> {
    const [cliVersion, objects] = await Promise.all([
      this.cliVersion(),
      this.deps.git.headObjects(project, worktree.path, [
        ...KEY_PATHS,
        ...keyFiles,
      ]),
    ]);
    const key = imageKey({ cliVersion, objects, generation: 0 });
    const ref = baseImageRef(project.id, key);
    let pending = this.building.get(ref);
    if (!pending) {
      pending = this.enqueue(project.id, () =>
        this.buildIfMissing(ref, worktree.hostPath, onLine)
      ).finally(() => this.building.delete(ref));
      this.building.set(ref, pending);
    }
    await pending;
    return { key, ref };
  }

  private enqueue<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(projectId) ?? Promise.resolve())
      .catch(() => {})
      .then(fn);
    this.queues.set(projectId, next);
    void next
      .catch(() => {})
      .finally(() => {
        if (this.queues.get(projectId) === next) this.queues.delete(projectId);
      });
    return next;
  }

  private async buildIfMissing(
    ref: string,
    folder: string,
    onLine: (line: string) => void
  ): Promise<void> {
    if (await this.deps.containers.imageExists(ref)) return;
    onLine(`image: building ${ref}`);
    await this.deps.containers.build(folder, ref, onLine);
    onLine(`image: built ${ref}`);
  }

  private cliVersion(): Promise<string> {
    this.cli ??= this.deps
      .run("devcontainer", ["--version"], { timeoutMs: 15_000 })
      .then((r) => r.stdout.trim() || "unknown");
    return this.cli;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/server/images.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/images.ts test/server/images.test.ts
git commit -m "feat: base images for task environments, built once per key and one at a time per project"
```

### Task 9: The store keeps task environments

**Files:**

- Modify: `src/server/state.ts`
- Test: `test/server/state.test.ts`

**Interfaces:**

- Consumes: `PersistedEnv` (Task 6), `compareSessions` (`src/server/status.ts`).
- Produces: `interface EnvRecord { id: EnvId; projectId: ProjectId; worktree: EnvWorktree; image?: { key: string; ref: string } }`; `StateStore.environments(projectId): EnvRecord[]`, `environment(id)`, `putEnvironment(rec)`, `removeEnvironment(id)`, `setIsolation(projectId, info)`, `isolation(projectId)`. `setSessions(envId, list)` stores per environment; `sessionsOf(projectId)` aggregates the main and task environments. The snapshot fills `environments` and `isolation`.

- [ ] **Step 1: Write the failing tests** — add to `test/server/state.test.ts`:

```ts
describe("task environments", () => {
  const rec = {
    id: "a-feat-0a1b",
    projectId: "a",
    worktree: {
      path: "/w/a.worktrees/feat",
      hostPath: "/src/a.worktrees/feat",
      branch: "feat",
    },
  };

  it("records an environment, persists it with its durable runtime, and restores it", () => {
    const { store, saved } = make();
    store.setProjects([p("a")]);
    store.putEnvironment(rec);
    store.updateRuntime(rec.id, {
      containerId: "c2",
      password: "pw2",
      containerState: "running",
    });
    expect(saved.at(-1)?.environments?.[rec.id]).toMatchObject({
      projectId: "a",
      worktree: rec.worktree,
      containerId: "c2",
      password: "pw2",
    });
    expect(saved.at(-1)?.projects).not.toHaveProperty(rec.id);
    const restored = make(saved.at(-1)).store;
    restored.setProjects([p("a")]);
    expect(restored.environment(rec.id)).toEqual(rec);
    expect(restored.runtime(rec.id)).toMatchObject({
      projectId: "a",
      containerId: "c2",
      containerState: "stopped",
    });
  });

  it("shows environments in the snapshot without secrets, with their own URL", () => {
    const { store } = make();
    store.setProjects([p("a")]);
    store.putEnvironment({ ...rec, image: { key: "k", ref: "r" } });
    store.updateRuntime(rec.id, {
      password: "secret2",
      containerState: "running",
    });
    store.setIsolation("a", { default: "isolated" });
    const view = store.snapshot().projects[0];
    expect(JSON.stringify(view)).not.toContain("secret2");
    expect(view.environments).toEqual([
      expect.objectContaining({
        id: rec.id,
        worktree: rec.worktree,
        image: { key: "k", ref: "r" },
        openUrl: `http://${rec.id}.localhost:7777/`,
      }),
    ]);
    expect(view.environments[0].runtime.containerState).toBe("running");
    expect(view.isolation).toEqual({ default: "isolated" });
  });

  it("lists a project's sessions from all its environments, newest first", () => {
    const { store } = make();
    store.setProjects([p("a")]);
    store.putEnvironment(rec);
    const s = (id: string, updatedAt: number, envId?: string) => ({
      id,
      projectId: "a",
      title: id,
      directory: "/w",
      updatedAt,
      status: "idle" as const,
      ...(envId ? { envId } : {}),
    });
    store.setSessions("a", [s("main", 1)]);
    store.setSessions(rec.id, [s("task", 2, rec.id)]);
    expect(store.sessionsOf("a").map((x) => x.id)).toEqual(["task", "main"]);
  });

  it("forgets an environment, its runtime and its sessions", () => {
    const { store, saved } = make();
    store.setProjects([p("a")]);
    store.putEnvironment(rec);
    store.setSessions(rec.id, [
      {
        id: "t",
        projectId: "a",
        title: "t",
        directory: "/w",
        updatedAt: 1,
        status: "idle",
      },
    ]);
    store.removeEnvironment(rec.id);
    expect(store.environments("a")).toEqual([]);
    expect(store.sessionsOf("a")).toEqual([]);
    expect(saved.at(-1)).not.toHaveProperty("environments");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/server/state.test.ts` Expected: FAIL — `putEnvironment is not a function`.

- [ ] **Step 3: Implement** — in `src/server/state.ts`, extend the imports with `EnvId`, `EnvWorktree`, `IsolationInfo`, `PublicRuntime` (shared types), `PersistedEnv` (config) and `import { compareSessions } from "./status";`. Add after `DURABLE_KEYS`:

```ts
/** A task environment opendevhub created: its worktree, and the image it was last started from. */
export interface EnvRecord {
  id: EnvId;
  projectId: ProjectId;
  worktree: EnvWorktree;
  image?: { key: string; ref: string };
}

function durable(r: ProjectRuntime): PersistedRuntime {
  return {
    containerId: r.containerId,
    password: r.password,
    workspaceFolder: r.workspaceFolder,
    relayToken: r.relayToken,
    ...(r.remoteUser ? { remoteUser: r.remoteUser } : {}),
  };
}

function publicRuntime(r: ProjectRuntime): PublicRuntime {
  const { password: _password, relayToken: _relayToken, ...rest } = r;
  return rest;
}
```

Add fields `private envs = new Map<EnvId, EnvRecord>();` and `private isolationInfo = new Map<ProjectId, IsolationInfo>();`. At the end of the constructor:

```ts
for (const [id, saved] of Object.entries(opts.persisted.environments ?? {})) {
  if (!saved?.worktree?.path || !saved.projectId) continue;
  const { projectId, worktree, image, ...runtime } = saved;
  this.envs.set(id, { id, projectId, worktree, ...(image ? { image } : {}) });
  this.runtimes.set(id, { ...defaultRuntime(projectId), ...runtime });
}
```

Replace `sessionsOf` and add the environment methods:

```ts
  /** The project's sessions across its main and task environments. */
  sessionsOf(id: ProjectId): SessionSummary[] {
    const main = this.sessions.get(id) ?? [];
    const envs = this.environments(id);
    if (envs.length === 0) return main;
    return [...main, ...envs.flatMap((e) => this.sessions.get(e.id) ?? [])].sort(compareSessions);
  }

  environments(projectId: ProjectId): EnvRecord[] {
    return [...this.envs.values()].filter((e) => e.projectId === projectId);
  }

  environment(id: EnvId): EnvRecord | undefined {
    return this.envs.get(id);
  }

  putEnvironment(rec: EnvRecord): void {
    this.envs.set(rec.id, rec);
    if (!this.runtimes.has(rec.id)) this.runtimes.set(rec.id, defaultRuntime(rec.projectId));
    this.save();
    this.emit();
  }

  removeEnvironment(id: EnvId): void {
    if (!this.envs.delete(id)) return;
    this.runtimes.delete(id);
    this.sessions.delete(id);
    this.save();
    this.emit();
  }

  setIsolation(projectId: ProjectId, info: IsolationInfo): void {
    if (JSON.stringify(this.isolationInfo.get(projectId)) === JSON.stringify(info)) return;
    this.isolationInfo.set(projectId, info);
    this.emit();
  }

  isolation(projectId: ProjectId): IsolationInfo | undefined {
    return this.isolationInfo.get(projectId);
  }
```

Replace the `projects:` mapping in `snapshot()`:

```ts
      projects: this.projects().map((project) => {
        const isolation = this.isolationInfo.get(project.id);
        return {
          project,
          runtime: publicRuntime(this.runtime(project.id)),
          sessions: this.sessionsOf(project.id),
          openUrl: projectUrl(project.id, this.opts.port),
          environments: this.environments(project.id).map((e) => ({
            id: e.id,
            worktree: e.worktree,
            ...(e.image ? { image: e.image } : {}),
            runtime: publicRuntime(this.runtime(e.id)),
            openUrl: projectUrl(e.id, this.opts.port),
          })),
          ...(isolation ? { isolation } : {}),
        };
      }),
```

Replace `save()`:

```ts
  private save(): void {
    const projects: Record<ProjectId, PersistedRuntime> = {};
    const environments: Record<EnvId, PersistedEnv> = {};
    for (const [id, r] of this.runtimes) {
      if (this.envs.has(id)) continue;
      if (r.containerId || r.password || r.workspaceFolder || r.relayToken) projects[id] = durable(r);
    }
    for (const [id, e] of this.envs) {
      environments[id] = { projectId: e.projectId, worktree: e.worktree, ...(e.image ? { image: e.image } : {}), ...durable(this.runtime(id)) };
    }
    this.opts.persist(Object.keys(environments).length > 0 ? { projects, environments } : { projects });
  }
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run test/server/state.test.ts && pnpm typecheck` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/state.ts test/server/state.test.ts
git commit -m "feat: the store keeps task environments, their sessions and the isolation default"
```

---

### Task 10: The orchestrator runs task environments and routes opencode calls to them

**Files:**

- Modify: `src/server/orchestrator.ts`
- Test: `test/server/orchestrator.test.ts`

**Interfaces:**

- Consumes: `Env` helpers (Task 4), `env-config` (Task 5), `EnvFiles`/`stateDir` (Task 6), `envLabels`, `ContainerInfo.envId`, `readConfig`, `remove`, `removeImage`, `PortConfig.configuration` (Task 7), `Images` (Task 8), `EnvRecord` and the store's environment methods (Task 9).
- Produces (public): `createEnv(projectId, worktreePath): Promise<{ envId: EnvId }>` (starts in the background), `startEnv(projectId, envId): Promise<void>`, `stopEnv(projectId, envId): Promise<void>`, `removeEnv(projectId, envId): Promise<void>` — `startEnv`, `stopEnv` and `removeEnv` throw `NotFoundError`/`BusyError` synchronously. `stop(projectId)` also stops the project's task containers. `adopt` and `refreshContainers` cover task containers.
- Produces (private, used by Task 11): `type TaskEnv = Env & { worktree: EnvWorktree }`, `taskEnv(project, rec)`, `recordTaskEnv(project, worktree: EnvWorktree): TaskEnv`, `ensureTaskEnv(project, worktree): Promise<TaskEnv>`, `bringUpTask(env)` (rethrows after recording the error), `destroyEnv(env)`, `isolationFor(project, requested): { isolated: boolean; notice?: string }`.
- New deps: `images?: ImagesPort`, `envFiles?: EnvFilesPort`, `projectSettings?: (project: Project) => unknown`. `ContainersPort` adds `"readConfig" | "remove" | "removeImage"`.

- [ ] **Step 1: Extend the test harness** — in `test/server/orchestrator.test.ts`:

Add imports: `type ExecTarget` from `../../src/server/containers`, `envIdFor` from `../../src/server/env-config`, `type EnvWorktree` from `../../src/shared/types`. After `running`, add:

```ts
// Untyped so it is both a Worktree and an EnvWorktree (hostPath is required in the latter).
const feat = {
  path: "/workspaces/demo.worktrees/feat",
  hostPath: "/src/demo.worktrees/feat",
  branch: "feat",
};
const featEnv = envIdFor(project.id, feat.path, "feat");
const runningTask: ContainerInfo = {
  id: "c2",
  name: "demo_feat",
  running: true,
  ip: "172.17.0.10",
  envId: featEnv,
  envProjectId: project.id,
  image: "vsc-feat-1234-uid",
  binds: {},
};
```

In `setup()`, replace the `up`, `inspect`, `stop` and `readConfiguration` fakes, and add the new ones:

```ts
    up: vi.fn(
      async (
        t: ExecTarget,
        o: { rebuild: boolean; onLine: (l: string) => void; mounts?: string[] },
      ): Promise<{ containerId: string; remoteWorkspaceFolder: string; remoteUser?: string }> => {
        o.onLine("building image");
        if (t.idLabels) return { containerId: "c2", remoteWorkspaceFolder: feat.path, remoteUser: "node" };
        return { containerId: "c1", remoteWorkspaceFolder: "/workspaces/demo", remoteUser: "node" };
      },
    ),
    inspect: vi.fn(async (id?: string): Promise<ContainerInfo | undefined> => (id === "c2" ? runningTask : running)),
    stop: vi.fn(async (_id: string) => {}),
    readConfiguration: vi.fn(async (_t?: ExecTarget) => ({
      forwardPorts: [3000, "db:5432"] as unknown[],
      portsAttributes: { "3000": { label: "web" } } as Record<string, unknown>,
      configuration: undefined as Record<string, unknown> | undefined,
    })),
    readConfig: vi.fn(async (_folder: string) => ({
      configuration: { image: "node:22", postCreateCommand: "npm ci", forwardPorts: [3000] } as Record<string, unknown>,
      workspaceFolder: "/workspaces/feat" as string | undefined,
    })),
    remove: vi.fn(async (_id: string) => {}),
    removeImage: vi.fn(async (_ref: string) => true),
```

After the `publisher` fake:

```ts
const images = {
  ensureBase: vi.fn(
    async (
      p: Project,
      _w: EnvWorktree,
      _keyFiles: string[],
      _onLine: (l: string) => void
    ) => ({
      key: "k".repeat(64),
      ref: `opendevhub/${p.id}:kkkkkkkkkkkk-base`,
    })
  ),
};
const envFiles = {
  path: (id: string) => `/state/envs/${id}/devcontainer.json`,
  write: vi.fn(
    async (id: string, _config: Record<string, unknown>) =>
      `/state/envs/${id}/devcontainer.json`
  ),
  remove: vi.fn(async (_id: string) => {}),
};
const projectSettings = vi.fn((_p: Project): unknown => undefined);
```

Pass `images, envFiles, projectSettings` to `new Orchestrator({ … })` and add them to `setup`'s return value. Add these helpers after `setup`:

```ts
/** A started project whose worktree list has `feat`. */
async function withWorktree(persisted?: PersistedState) {
  const s = setup(persisted);
  s.worktrees.list.mockResolvedValue([feat]);
  await s.orch.rescan();
  await s.orch.start(project.id);
  return s;
}

/** …and `feat` running in its own container. */
async function withEnv() {
  const s = await withWorktree();
  const { envId } = await s.orch.createEnv(project.id, feat.path);
  await vi.waitFor(() =>
    expect(s.store.runtime(envId).opencode).toBe("healthy")
  );
  return { ...s, envId };
}
```

Run: `pnpm vitest run test/server/orchestrator.test.ts` Expected: the existing tests still PASS (`createEnv` doesn't exist yet, but nothing calls these helpers so far; `pnpm typecheck` will fail until Step 4).

- [ ] **Step 2: Write the failing tests** — add a new `describe` to `test/server/orchestrator.test.ts`:

```ts
describe("task environments", () => {
  it("gives a worktree its own container from the base image", async () => {
    const {
      orch,
      store,
      containers,
      images,
      envFiles,
      runtime,
      forwarder,
      monitors,
      envId,
    } = await withEnv();
    expect(envId).toBe(featEnv);
    expect(store.environment(envId)).toMatchObject({
      projectId: project.id,
      worktree: feat,
      image: { ref: `opendevhub/${project.id}:kkkkkkkkkkkk-base` },
    });
    expect(images.ensureBase.mock.calls[0].slice(0, 3)).toEqual([
      project,
      feat,
      [],
    ]);
    expect(containers.readConfig).toHaveBeenCalledWith(feat.hostPath);
    const written = envFiles.write.mock.calls[0][1];
    expect(written).toMatchObject({
      image: `opendevhub/${project.id}:kkkkkkkkkkkk-base`,
      workspaceFolder: feat.path,
      mounts: ["type=bind,source=/src/demo/.git,target=/workspaces/demo/.git"],
    });
    expect(written).not.toHaveProperty("postCreateCommand");
    expect(containers.up.mock.calls.at(-1)![0]).toEqual({
      id: envId,
      path: feat.hostPath,
      idLabels: [
        `opendevhub.env=${envId}`,
        `opendevhub.env-project=${project.id}`,
      ],
      overrideConfig: `/state/envs/${envId}/devcontainer.json`,
    });
    expect(runtime.ensureRunning.mock.calls.at(-1)![1]).toMatchObject({
      address: { host: "172.17.0.10", port: 4096 },
      workspaceFolder: feat.path,
    });
    expect(forwarder.open.mock.calls.at(-1)![0]).toBe(envId);
    expect(monitors.at(-1)!.opts).toMatchObject({
      envId,
      projectId: project.id,
      directory: feat.path,
    });
    expect(monitors.at(-1)!.opts.extraDirectories).toBeUndefined();
    expect(monitors[0].opts.extraDirectories!()).toEqual([]);
    expect(orch.opencodeAddress(envId)).toEqual({
      host: "172.17.0.10",
      port: 4096,
    });
    expect(store.runtime(project.id).containerId).toBe("c1");
  });

  it("records why a worktree's config can't get its own container", async () => {
    const s = await withWorktree();
    s.containers.readConfig.mockResolvedValueOnce({
      configuration: { dockerComposeFile: "c.yml" },
      workspaceFolder: "/workspaces/feat",
    });
    const { envId } = await s.orch.createEnv(project.id, feat.path);
    await vi.waitFor(() =>
      expect(s.store.runtime(envId).containerState).toBe("error")
    );
    expect(s.store.runtime(envId).error).toMatch(/Docker Compose/);
    expect(s.containers.up).toHaveBeenCalledTimes(1);
  });

  it("refuses its own container when the project's config can't run one per worktree", async () => {
    const s = setup();
    s.worktrees.list.mockResolvedValue([feat]);
    s.containers.readConfiguration.mockResolvedValue({
      forwardPorts: [],
      portsAttributes: {},
      configuration: { appPort: 3000 },
    });
    await s.orch.rescan();
    await s.orch.start(project.id);
    expect(s.store.isolation(project.id)).toEqual({
      default: "shared",
      unsupported: expect.stringMatching(/appPort/),
    });
    await expect(
      s.orch.createEnv(project.id, feat.path)
    ).rejects.toBeInstanceOf(InvalidRequestError);
  });

  it("reads the isolation default from devcontainer.json, with config.json taking precedence", async () => {
    const s = setup();
    s.containers.readConfiguration.mockResolvedValue({
      forwardPorts: [],
      portsAttributes: {},
      configuration: {
        customizations: { opendevhub: { isolation: "isolated" } },
      },
    });
    await s.orch.rescan();
    await s.orch.start(project.id);
    expect(s.store.isolation(project.id)).toEqual({ default: "isolated" });
    s.projectSettings.mockReturnValue({ isolation: "shared" });
    await s.orch.rebuild(project.id);
    expect(s.store.isolation(project.id)).toEqual({ default: "shared" });
  });

  it("only gives known worktrees in the mounted folder their own container, while the project runs", async () => {
    const s = await withWorktree();
    await expect(
      s.orch.createEnv(project.id, "/elsewhere")
    ).rejects.toBeInstanceOf(InvalidRequestError);
    s.store.updateRuntime(project.id, {
      worktrees: [{ path: "/tmp/wt", branch: "x" }],
    });
    await expect(s.orch.createEnv(project.id, "/tmp/wt")).rejects.toThrow(
      /mounted worktrees folder/
    );
    await s.orch.stop(project.id);
    await expect(
      s.orch.createEnv(project.id, feat.path)
    ).rejects.toBeInstanceOf(UnavailableError);
  });

  it("stops a task container on its own, and together with the project", async () => {
    const { orch, store, containers, envId } = await withEnv();
    store.setSessions(envId, [
      {
        id: "t",
        projectId: project.id,
        envId,
        title: "t",
        directory: feat.path,
        updatedAt: 1,
        status: "idle",
      },
    ]);
    await orch.stopEnv(project.id, envId);
    expect(containers.stop).toHaveBeenCalledWith("c2");
    expect(store.runtime(envId).containerState).toBe("stopped");
    expect(store.sessionsOf(project.id).map((s) => s.id)).not.toContain("t");
    expect(store.runtime(project.id).containerState).toBe("running");
    await orch.startEnv(project.id, envId);
    expect(store.runtime(envId).opencode).toBe("healthy");
    containers.stop.mockClear();
    await orch.stop(project.id);
    expect(containers.stop.mock.calls.map((c) => c[0])).toEqual(["c2", "c1"]);
    expect(store.runtime(envId).containerState).toBe("stopped");
  });

  it("removes a task container, the image the CLI left for it, its config and its record", async () => {
    const { orch, store, containers, envFiles, envId } = await withEnv();
    containers.remove.mockRejectedValueOnce(
      new CommandError("docker rm failed: busy")
    );
    await expect(orch.removeEnv(project.id, envId)).rejects.toThrow(/busy/);
    expect(store.environment(envId)).toBeDefined();
    await orch.removeEnv(project.id, envId);
    expect(containers.remove).toHaveBeenLastCalledWith("c2");
    expect(containers.removeImage).toHaveBeenCalledWith("vsc-feat-1234-uid");
    expect(envFiles.remove).toHaveBeenCalledWith(envId);
    expect(store.environment(envId)).toBeUndefined();
    expect(orch.opencodeAddress(envId)).toBeUndefined();
  });

  it("re-adopts running task containers after a restart and ignores ones it has no record of", async () => {
    const s = setup({
      projects: {
        [project.id]: { password: "pw", workspaceFolder: "/workspaces/demo" },
      },
      environments: {
        [featEnv]: {
          projectId: project.id,
          worktree: feat,
          containerId: "c2",
          password: "pw",
        },
      },
    });
    const stray: ContainerInfo = {
      ...runningTask,
      id: "c3",
      name: "stray",
      envId: "demo-abc123-old-ffff",
    };
    s.containers.listManaged.mockResolvedValueOnce([
      running,
      runningTask,
      stray,
    ]);
    await s.orch.rescan();
    await s.orch.adopt();
    expect(s.store.runtime(project.id)).toMatchObject({
      containerId: "c1",
      opencode: "healthy",
    });
    expect(s.store.runtime(featEnv)).toMatchObject({
      containerId: "c2",
      containerState: "running",
      opencode: "healthy",
    });
    expect(s.monitors.map((m) => m.opts.envId)).toEqual([project.id, featEnv]);
    expect(
      s.orch
        .logLines(project.id)
        .some((l) => l.includes("ignoring container stray"))
    ).toBe(true);
    expect(s.store.environments(project.id)).toHaveLength(1);
    expect(s.store.runtime("demo-abc123-old-ffff").containerId).toBeUndefined();
  });

  it("notices a task container stopped outside opendevhub", async () => {
    const { orch, store, containers, envId } = await withEnv();
    containers.inspect.mockImplementation(async (id?: string) =>
      id === "c2" ? { ...runningTask, running: false } : running
    );
    await orch.refreshContainers();
    expect(store.runtime(envId).containerState).toBe("stopped");
    expect(store.runtime(project.id).containerState).toBe("running");
  });

  it("sends a worktree's sessions and replies to its own opencode", async () => {
    const { orch, store, clientFor, client, envId } = await withEnv();
    clientFor.mockClear();
    await orch.startSession(project.id, feat.path);
    expect(clientFor.mock.calls[0][0].baseUrl).toBe("http://172.17.0.10:4096");
    clientFor.mockClear();
    await orch.startSession(project.id, "/workspaces/demo");
    expect(clientFor.mock.calls[0][0].baseUrl).toBe("http://172.17.0.9:4096");
    store.setSessions(envId, [
      {
        ...waiting({ permissions: [permission], forms: [] }),
        envId,
        directory: feat.path,
      },
    ]);
    clientFor.mockClear();
    await orch.replyPermission(project.id, "per_1", { decision: "once" });
    expect(clientFor.mock.calls[0][0].baseUrl).toBe("http://172.17.0.10:4096");
    expect(client.replyPermission).toHaveBeenCalled();
    await orch.stopEnv(project.id, envId);
    await expect(orch.startSession(project.id, feat.path)).rejects.toThrow(
      /container is not running/
    );
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm vitest run test/server/orchestrator.test.ts -t "task environments"` Expected: FAIL — `orch.createEnv is not a function`.

- [ ] **Step 4: Add deps and helpers** — in `src/server/orchestrator.ts`:

Imports: add `EnvRecord` (type) from `./state`; `envLabels` from `./containers`; `buildOverrideConfig, envIdFor, type EnvSettings, isolationBlocker, resolveEnvSettings` from `./env-config`; `EnvFiles` from `./env-files`; `stateDir` from `./config`; `type Images` from `./images`; and `Isolation`, `TaskVariantSpec` from `../shared/types`.

Replace `ContainersPort` and add ports:

```ts
export type ContainersPort = Pick<
  Containers,
  | "up"
  | "inspect"
  | "listManaged"
  | "stop"
  | "readConfiguration"
  | "workspaceFolder"
  | "readConfig"
  | "remove"
  | "removeImage"
>;
export type ImagesPort = Pick<Images, "ensureBase">;
export type EnvFilesPort = Pick<EnvFiles, "path" | "write" | "remove">;
```

Add to `OrchestratorDeps`:

```ts
  /** Base images for task environments. */
  images?: ImagesPort;
  /** Where task environments' generated configs live; defaults to the state folder. */
  envFiles?: EnvFilesPort;
  /** The project's entry in config.json `projects`. */
  projectSettings?: (project: Project) => unknown;
```

After the `Env` interface:

```ts
type TaskEnv = Env & { worktree: EnvWorktree };
```

Fields:

```ts
  /** Isolation settings per project, read when its main container forwards ports. */
  private readonly settings = new Map<ProjectId, EnvSettings>();
  private defaultEnvFiles?: EnvFilesPort;
```

Replace `envOf`, `allEnvs` and `sharedWorktrees`, and add the new helpers:

```ts
  private envOf(id: EnvId): Env | undefined {
    const { store } = this.deps;
    const project = store.project(id);
    if (project) return this.mainEnv(project);
    const rec = store.environment(id);
    const owner = rec && store.project(rec.projectId);
    return rec && owner ? this.taskEnv(owner, rec) : undefined;
  }

  private allEnvs(): Env[] {
    return this.deps.store
      .projects()
      .flatMap((p) => [this.mainEnv(p), ...this.deps.store.environments(p.id).map((r) => this.taskEnv(p, r))]);
  }

  /** Worktrees the main environment's opencode serves: all but those with their own container. */
  private sharedWorktrees(projectId: ProjectId): string[] {
    const own = new Set(this.deps.store.environments(projectId).map((e) => e.worktree.path));
    return (this.deps.store.runtime(projectId).worktrees ?? []).map((w) => w.path).filter((p) => !own.has(p));
  }

  private envFiles(): EnvFilesPort {
    return this.deps.envFiles ?? (this.defaultEnvFiles ??= new EnvFiles(path.join(stateDir(), "envs")));
  }

  private taskEnv(project: Project, rec: EnvRecord): TaskEnv {
    return {
      id: rec.id,
      project,
      worktree: rec.worktree,
      target: { id: rec.id, path: rec.worktree.hostPath, idLabels: envLabels(rec.id, project.id), overrideConfig: this.envFiles().path(rec.id) },
    };
  }

  private requireTaskEnv(projectId: ProjectId, envId: EnvId): TaskEnv {
    const project = this.requireProject(projectId);
    const rec = this.deps.store.environment(envId);
    if (!rec || rec.projectId !== projectId) throw new NotFoundError(envId, "environment");
    return this.taskEnv(project, rec);
  }

  /** The environment whose opencode serves a checkout: the worktree's own, or the project's. */
  private envForDirectory(project: Project, directory: string): Env {
    const rec = this.deps.store.environments(project.id).find((e) => e.worktree.path === directory);
    return rec ? this.taskEnv(project, rec) : this.mainEnv(project);
  }

  private settingsOf(project: Project): EnvSettings {
    return this.settings.get(project.id) ?? resolveEnvSettings(undefined, this.deps.projectSettings?.(project));
  }

  /** Reads the project's isolation settings from its devcontainer.json (as read for ports) and config.json. */
  private noteSettings(project: Project, configuration: Record<string, unknown> | undefined): void {
    const custom = (configuration?.customizations as Record<string, unknown> | undefined)?.opendevhub;
    const settings = resolveEnvSettings(custom, this.deps.projectSettings?.(project));
    this.settings.set(project.id, settings);
    const unsupported = configuration ? isolationBlocker(configuration) : undefined;
    this.deps.store.setIsolation(project.id, unsupported ? { default: "shared", unsupported } : { default: settings.isolation });
  }

  /** Whether a task's worktrees get their own containers, and why not when that was asked for. */
  private isolationFor(project: Project, requested: Isolation | undefined): { isolated: boolean; notice?: string } {
    const info = this.deps.store.isolation(project.id);
    const wanted = requested ?? info?.default ?? this.settingsOf(project).isolation;
    if (wanted !== "isolated") return { isolated: false };
    if (info?.unsupported) return { isolated: false, notice: `runs in the shared container: ${info.unsupported}` };
    return { isolated: true };
  }
```

In `forwardPorts`, call `if (!env.worktree) this.noteSettings(env.project, undefined);` in the `catch` before `return`, and `if (!env.worktree) this.noteSettings(env.project, config.configuration);` right after a successful `readConfiguration`.

In `opencodeClient(id)`, replace the thrown error with:

```ts
throw new UnavailableError(
  this.deps.store.environment(id)
    ? "this worktree's container is not running — start it from the Worktrees tab"
    : "opencode is not running — start the project first"
);
```

- [ ] **Step 5: Add the task environment lifecycle** — public methods (after `stop`):

```ts
  /** Gives a worktree its own container and starts it in the background. */
  async createEnv(projectId: ProjectId, worktreePath: string): Promise<{ envId: EnvId }> {
    const project = this.requireProject(projectId);
    const { store } = this.deps;
    if (store.runtime(projectId).containerState !== "running") {
      throw new UnavailableError("the container is not running — start the project first");
    }
    const unsupported = store.isolation(projectId)?.unsupported;
    if (unsupported) throw new InvalidRequestError(unsupported);
    const wt = store.runtime(projectId).worktrees?.find((w) => w.path === worktreePath);
    if (!wt) throw new InvalidRequestError(`unknown worktree ${worktreePath}`);
    if (!wt.hostPath) throw new InvalidRequestError(`${worktreePath} is not in the mounted worktrees folder, so it can't get its own container`);
    const env = this.recordTaskEnv(project, { path: wt.path, hostPath: wt.hostPath, branch: wt.branch ?? path.posix.basename(wt.path) });
    void this.exclusiveEnv(env, () => this.bringUpTask(env)).catch(() => {});
    return { envId: env.id };
  }

  startEnv(projectId: ProjectId, envId: EnvId): Promise<void> {
    const env = this.requireTaskEnv(projectId, envId);
    return this.exclusiveEnv(env, () => this.bringUpTask(env));
  }

  stopEnv(projectId: ProjectId, envId: EnvId): Promise<void> {
    const env = this.requireTaskEnv(projectId, envId);
    return this.exclusiveEnv(env, () => this.stopContainer(env));
  }

  /** Deletes a worktree's container; the worktree and its files stay, its sessions go. */
  removeEnv(projectId: ProjectId, envId: EnvId): Promise<void> {
    const env = this.requireTaskEnv(projectId, envId);
    return this.exclusiveEnv(env, () => this.destroyEnv(env));
  }
```

Replace `stop`:

```ts
  stop(id: ProjectId): Promise<void> {
    return this.exclusive(id, async (p) => {
      const { store } = this.deps;
      for (const rec of store.environments(p.id)) {
        const env = this.taskEnv(p, rec);
        const rt = store.runtime(env.id);
        if (this.busy.has(env.id) || !rt.containerId || rt.containerState === "stopped") continue;
        await this.exclusiveEnv(env, () => this.stopContainer(env));
      }
      await this.stopContainer(this.mainEnv(p));
    });
  }
```

In `adopt`, make the loop's first line `if (info.envId) { await this.adoptTask(info); continue; }`, and add the private methods:

```ts
  private async adoptTask(info: ContainerInfo): Promise<void> {
    const { store } = this.deps;
    const rec = store.environment(info.envId!);
    const project = rec && store.project(rec.projectId);
    if (!rec || !project) {
      const owner = info.envProjectId ? store.project(info.envProjectId) : undefined;
      if (owner) this.log(owner.id, `environment: ignoring container ${info.name ?? info.id}: opendevhub has no record of ${info.envId}`);
      return;
    }
    const env = this.taskEnv(project, rec);
    if (!info.running) {
      store.updateRuntime(env.id, { containerId: info.id, containerState: "stopped", opencode: "absent" });
      return;
    }
    store.updateRuntime(env.id, { containerId: info.id, containerName: info.name, containerIp: info.ip, containerState: "running" });
    await this.adoptRunning(env, info);
  }

  /** Records a worktree's own environment (or returns the one it has). */
  private recordTaskEnv(project: Project, worktree: EnvWorktree): TaskEnv {
    const { store } = this.deps;
    const existing = store.environments(project.id).find((e) => e.worktree.path === worktree.path);
    if (existing) return this.taskEnv(project, existing);
    const rec: EnvRecord = { id: envIdFor(project.id, worktree.path, worktree.branch), projectId: project.id, worktree };
    store.putEnvironment(rec);
    return this.taskEnv(project, rec);
  }

  /** The worktree's own environment, started unless it already runs. */
  private async ensureTaskEnv(project: Project, worktree: EnvWorktree): Promise<TaskEnv> {
    const env = this.recordTaskEnv(project, worktree);
    const rt = this.deps.store.runtime(env.id);
    if (rt.containerState === "running" && rt.opencode === "healthy") return env;
    await this.exclusiveEnv(env, () => this.bringUpTask(env));
    return env;
  }

  /**
   * Starts a task container: the base image for the worktree's config, the override config, `up`, then
   * route, relay, ports and opencode as for the main container. Records the error and rethrows it.
   */
  private async bringUpTask(env: TaskEnv): Promise<void> {
    const { store, containers } = this.deps;
    store.updateRuntime(env.id, { containerState: "starting", opencode: "absent", error: undefined });
    try {
      if (store.runtime(env.project.id).containerState !== "running") {
        throw new UnavailableError("start the project first: task containers are prepared from its container");
      }
      const images = this.deps.images;
      if (!images) throw new UnavailableError("task environments are not available in this build");
      const image = await images.ensureBase(env.project, env.worktree, this.settingsOf(env.project).keyFiles, (l) => this.envLog(env, l));
      const read = await containers.readConfig(env.worktree.hostPath);
      const blocker = isolationBlocker(read.configuration, read.workspaceFolder);
      if (blocker) throw new UnavailableError(blocker);
      const { config, notes } = buildOverrideConfig({
        config: read.configuration,
        guessedFolder: read.workspaceFolder,
        image: image.ref,
        worktree: env.worktree,
        gitDir: { host: path.join(env.project.path, ".git"), container: path.posix.join(this.workspaceFolder(env.project), ".git") },
      });
      for (const note of notes) this.envLog(env, `environment: ${note}`);
      await this.envFiles().write(env.id, config);
      const rec = store.environment(env.id);
      if (rec) store.putEnvironment({ ...rec, image });
      const up = await containers.up(env.target, { rebuild: false, onLine: (l) => this.envLog(env, l) });
      store.updateRuntime(env.id, { containerId: up.containerId });
      const info = await containers.inspect(up.containerId);
      if (!info?.running) throw new CommandError("container is not running after devcontainer up");
      if (!info.ip) throw new CommandError("container has no bridge network IP (host networking is not supported)");
      store.updateRuntime(env.id, {
        containerId: up.containerId,
        containerName: info.name,
        containerIp: info.ip,
        remoteUser: up.remoteUser,
        workspaceFolder: up.remoteWorkspaceFolder,
        containerState: "running",
        opencode: "starting",
      });
      const route = await this.openRoute(env, { id: up.containerId, ip: info.ip, network: info.network });
      await this.forwardPorts(env, await this.startRelay(env, info.ip, route));
      await this.launchOpencode(env, store.runtime(env.id).password);
    } catch (err) {
      this.fail(env, err);
      throw err;
    }
  }

  /** Deletes a task container, its generated config and the UID image the CLI built for it. Throws when the container stays. */
  private async destroyEnv(env: TaskEnv): Promise<void> {
    const { store, containers } = this.deps;
    this.stopMonitor(env.id);
    await this.closePorts(env.id);
    await this.closeRoute(env.id);
    const containerId = store.runtime(env.id).containerId;
    if (containerId) {
      const image = (await containers.inspect(containerId).catch(() => undefined))?.image;
      await containers.remove(containerId);
      if (image && /^vsc-.+-uid$/.test(image.split(":")[0])) await containers.removeImage(image);
    }
    await this.envFiles().remove(env.id).catch(() => {});
    store.removeEnvironment(env.id);
    this.envLog(env, "environment: removed");
  }
```

- [ ] **Step 6: Route opencode calls by environment** — change these methods in `src/server/orchestrator.ts`:

`startSession`:

```ts
  async startSession(id: ProjectId, directory: string, title?: string, prompt?: string): Promise<string> {
    const project = this.requireProject(id);
    this.checkDirectory(id, directory);
    const env = this.envForDirectory(project, directory);
    const client = this.opencodeClient(env.id);
    const session = await client.createSession(directory, { title });
    if (prompt?.trim()) await client.prompt(session.id, prompt, undefined, directory);
    this.monitors.get(env.id)?.reconcile?.();
    return session.id;
  }
```

`promptSession`: use `const envId = session.envId ?? id;`, then `this.opencodeClient(envId)` and `this.monitors.get(envId)?.reconcile?.()`.

`review`: `const client = this.opencodeClient(this.envForDirectory(project, directory).id);`.

`commitMessage` and `publishSuggestion`: `this.opencodeClient(session.envId ?? id)`.

`openInEditor`: after the host path is computed, take the container from the directory's environment:

```ts
const envRt = this.deps.store.runtime(
  this.envForDirectory(project, directory).id
);
return this.deps.editors.open(editorId, {
  containerPath: directory,
  hostPath,
  containerName:
    envRt.containerState === "running" ? envRt.containerName : undefined,
});
```

`respond`: record the session's environment with the item and use it:

```ts
let found: { item: T; directory: string; envId: EnvId } | undefined;
for (const s of this.deps.store.sessionsOf(id)) {
  const item = s.pending && find(s.pending);
  if (item) {
    found = { item, directory: s.directory, envId: s.envId ?? id };
    break;
  }
}
if (!found) throw new NotFoundError(itemId, what);
const client = this.opencodeClient(found.envId);
```

and in its `finally`, reconcile `found.envId`'s monitor (keep the project's too: `this.monitors.get(id)?.reconcile?.(); if (found.envId !== id) this.monitors.get(found.envId)?.reconcile?.();`).

`pickVariant`: remove `const client = this.opencodeClient(id);` and use each session's own environment:

```ts
const clientOf = (s: SessionSummary) => this.opencodeClient(s.envId ?? id);
const kept = variants.find((s) => s.id === keep)!;
// A concurrent pick may have discarded this variant since the dashboard last saw it.
if (parseTaskMeta((await clientOf(kept).session(keep)).metadata)?.discarded)
  throw new InvalidRequestError("that variant was already discarded");
```

In `discard`, use `const client = clientOf(s);` inside the loop (within the `try`), and replace the single reconcile with:

```ts
for (const envId of new Set([id, ...others.map((s) => s.envId ?? id)]))
  this.monitors.get(envId)?.reconcile?.();
```

- [ ] **Step 7: Run the tests**

Run: `pnpm vitest run test/server/orchestrator.test.ts && pnpm typecheck` Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/server/orchestrator.ts test/server/orchestrator.test.ts
git commit -m "feat: run worktrees in their own containers and route their opencode calls there"
```

### Task 11: Tasks and worktree removal with their own containers

**Files:**

- Modify: `src/server/tasks.ts`, `src/server/orchestrator.ts`
- Test: `test/server/tasks.test.ts`, `test/server/orchestrator.test.ts`

**Interfaces:**

- Consumes: `isolationFor`, `ensureTaskEnv`, `destroyEnv`, `taskEnv` (Task 10).
- Produces: `parseTaskRequest` accepts `environment: "shared" | "isolated"`; `createTask` starts isolated variants in their own containers (`TaskVariantResult.envId`, or `notice` when it fell back to shared); `removeWorktree` and `pickVariant` remove a worktree's container before the worktree.

- [ ] **Step 1: Write the failing tests** — add to `test/server/tasks.test.ts` (inside the `parseTaskRequest` describe):

```ts
it("accepts the environment of worktree tasks", () => {
  expect(
    parseTaskRequest({ prompt: "x", environment: "isolated" }).environment
  ).toBe("isolated");
  expect(parseTaskRequest({ prompt: "x" })).not.toHaveProperty("environment");
  expect(() => parseTaskRequest({ prompt: "x", environment: "vm" })).toThrow(
    /invalid environment/
  );
  expect(() =>
    parseTaskRequest({
      prompt: "x",
      where: "workspace",
      environment: "isolated",
    })
  ).toThrow(/new worktree/);
});
```

Add to `describe("task environments")` in `test/server/orchestrator.test.ts`:

```ts
it("starts each variant of an isolated task in its own container", async () => {
  const s = await withWorktree();
  const r = await s.orch.createTask(project.id, {
    prompt: "Do it",
    title: "Iso",
    where: "worktree",
    environment: "isolated",
    variants: [{}, {}],
  });
  expect(r.variants.map((v) => v.branch)).toEqual(["iso-1", "iso-2"]);
  expect(r.variants.every((v) => v.envId && v.sessionId && !v.error)).toBe(
    true
  );
  expect(new Set(r.variants.map((v) => v.envId)).size).toBe(2);
  expect(s.images.ensureBase).toHaveBeenCalledTimes(2);
  expect(s.client.createSession.mock.calls.map((c) => c[0]).sort()).toEqual([
    "/workspaces/demo.worktrees/iso-1",
    "/workspaces/demo.worktrees/iso-2",
  ]);
  expect(
    s.store
      .environments(project.id)
      .map((e) => e.worktree.branch)
      .sort()
  ).toEqual(["iso-1", "iso-2"]);
});

it("uses the project's default when the task doesn't choose", async () => {
  const s = setup();
  s.projectSettings.mockReturnValue({ isolation: "isolated" });
  await s.orch.rescan();
  await s.orch.start(project.id);
  const r = await s.orch.createTask(project.id, {
    prompt: "Do it",
    title: "Iso",
    variants: [{}],
  });
  expect(r.variants[0].envId).toBeDefined();
  const shared = await s.orch.createTask(project.id, {
    prompt: "Do it",
    title: "Sh",
    environment: "shared",
    variants: [{}],
  });
  expect(shared.variants[0].envId).toBeUndefined();
});

it("runs an isolated task shared, and says why, when the project can't isolate", async () => {
  const s = setup();
  s.containers.readConfiguration.mockResolvedValue({
    forwardPorts: [],
    portsAttributes: {},
    configuration: { appPort: 1 },
  });
  await s.orch.rescan();
  await s.orch.start(project.id);
  const r = await s.orch.createTask(project.id, {
    prompt: "Do it",
    title: "Iso",
    environment: "isolated",
    variants: [{}],
  });
  expect(r.variants[0]).toMatchObject({
    sessionId: "ses_new",
    notice: expect.stringMatching(/shared container: appPort/),
  });
  expect(r.variants[0].envId).toBeUndefined();
});

it("keeps the worktree of a variant whose container didn't start", async () => {
  const s = await withWorktree();
  s.images.ensureBase.mockRejectedValueOnce(
    new CommandError("devcontainer build failed: boom")
  );
  const r = await s.orch.createTask(project.id, {
    prompt: "Do it",
    title: "Iso",
    environment: "isolated",
    variants: [{}],
  });
  expect(r.variants[0].error).toMatch(
    /its container did not start: devcontainer build failed: boom/
  );
  expect(r.variants[0].directory).toBe("/workspaces/demo.worktrees/iso");
  expect(s.worktrees.remove).not.toHaveBeenCalled();
});

it("removes a worktree's container before the worktree, and keeps the worktree when that fails", async () => {
  const { orch, containers, worktrees, store, envId } = await withEnv();
  containers.remove.mockRejectedValueOnce(
    new CommandError("docker rm failed: busy")
  );
  await expect(
    orch.removeWorktree(project.id, feat.path, false)
  ).rejects.toThrow(/kept the worktree/);
  expect(worktrees.remove).not.toHaveBeenCalled();
  await orch.removeWorktree(project.id, feat.path, false);
  expect(containers.remove.mock.invocationCallOrder.at(-1)!).toBeLessThan(
    worktrees.remove.mock.invocationCallOrder[0]
  );
  expect(store.environment(envId)).toBeUndefined();
});

it("Pick removes a discarded variant's container with its worktree", async () => {
  const { orch, store, containers, envId } = await withEnv();
  const meta = (variant: number, branch?: string) => ({
    task: "tsk_1",
    variant,
    of: 2,
    title: "T",
    ...(branch ? { branch } : {}),
  });
  store.setSessions(project.id, [
    {
      id: "ses_keep",
      projectId: project.id,
      title: "T",
      directory: "/workspaces/demo",
      updatedAt: 1,
      status: "idle",
      task: meta(1),
    },
  ]);
  store.setSessions(envId, [
    {
      id: "ses_drop",
      projectId: project.id,
      envId,
      title: "T",
      directory: feat.path,
      updatedAt: 1,
      status: "idle",
      task: meta(2, "feat"),
    },
  ]);
  const r = await orch.pickVariant(project.id, "tsk_1", "ses_keep", true);
  expect(r).toEqual({
    discarded: ["ses_drop"],
    removed: [feat.path],
    errors: [],
  });
  expect(containers.remove).toHaveBeenCalledWith("c2");
  expect(store.environment(envId)).toBeUndefined();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/server/tasks.test.ts test/server/orchestrator.test.ts -t "environment|isolated|container|Pick removes"` Expected: FAIL.

- [ ] **Step 3: Parse `environment`** — in `src/server/tasks.ts` `parseTaskRequest`, after `where` is validated:

```ts
const environment = body.environment ?? undefined;
if (
  environment !== undefined &&
  environment !== "shared" &&
  environment !== "isolated"
) {
  throw new InvalidRequestError(`invalid environment "${String(environment)}"`);
}
```

inside the `if (where === "workspace")` block:

```ts
if (environment === "isolated")
  throw new InvalidRequestError(
    "only a new worktree can get its own container"
  );
```

and add `...(environment ? { environment } : {}),` to the returned object after `where,`.

- [ ] **Step 4: Rewrite `createTask`** — replace it in `src/server/orchestrator.ts` with:

```ts
  /**
   * Starts a task: for each variant, a worktree (unless it runs in the main checkout), a session tagged with
   * the task in its metadata, and the prompt. Worktrees are created in order under one git lock; a failing
   * variant is recorded on its result and the others still run, and worktrees already created are kept.
   * Isolated variants then start their own containers in parallel and get their sessions there.
   */
  async createTask(id: ProjectId, body: Record<string, unknown>): Promise<TaskResult> {
    const req = parseTaskRequest(body);
    const client = this.opencodeClient(id);
    const project = this.requireProject(id);
    const { isolated, notice } = req.where === "worktree" ? this.isolationFor(project, req.environment) : { isolated: false, notice: undefined };
    const title = req.title ?? deriveTitle(req.prompt);
    const of = req.variants.length;
    const labels = variantLabels(req.variants);
    const own: (EnvWorktree | undefined)[] = [];
    const { task, results } = await this.withGit(id, async (p) => {
      const rt = this.deps.store.runtime(id);
      const ws = this.workspaceFolder(p);
      const root = rt.worktreeRoot;
      const task = newTaskId((this.deps.now ?? Date.now)());
      let branches: string[] = [];
      if (req.where === "worktree") {
        if (!root?.mounted) throw new UnavailableError(NO_WORKTREE_MOUNT);
        const taken = new Set([
          ...(await this.deps.git.localBranches(p, ws)),
          ...(rt.worktrees ?? []).flatMap((w) => (w.branch ? [w.branch] : [])),
        ]);
        branches = taskBranches({ branch: req.branch, title, variants: req.variants, taken }).map(validateBranch);
      }
      const results: TaskVariantResult[] = [];
      for (const [i, v] of req.variants.entries()) {
        const branch = branches[i];
        const result: TaskVariantResult = branch ? { branch } : { directory: ws };
        if (notice) result.notice = notice;
        results.push(result);
        try {
          if (branch) {
            const wt = await this.deps.worktrees.add(p, { workspaceFolder: ws, root: root!, branch, base: req.base, onLine: (l) => this.log(id, l) });
            result.directory = wt.path;
            if (isolated && wt.hostPath) {
              own[i] = { path: wt.path, hostPath: wt.hostPath, branch };
              continue;
            }
          }
          const meta: TaskMeta = { task, variant: i + 1, of, title, ...(branch ? { branch } : {}) };
          await this.startVariant(client, result, result.directory!, meta, variantTitle(title, labels[i], of), v, req.prompt);
        } catch (err) {
          this.variantFailed(id, title, i, branch, result, err);
        }
      }
      if (branches.length > 0) {
        const created = results.flatMap((r) => (r.branch && r.directory ? [{ path: r.directory, branch: r.branch }] : []));
        const list = await this.deps.worktrees.list(p, ws, root).catch(() => {
          const known = rt.worktrees ?? [];
          return [...known, ...created.filter((c) => !known.some((w) => w.path === c.path))];
        });
        this.deps.store.updateRuntime(id, { worktrees: list });
      }
      return { task, results };
    });
    await Promise.all(
      own.map(async (worktree, i) => {
        if (!worktree) return;
        const result = results[i];
        try {
          const env = await this.ensureTaskEnv(project, worktree).catch((err: unknown) => {
            throw new Error(`its container did not start: ${err instanceof Error ? err.message : String(err)}`);
          });
          result.envId = env.id;
          const meta: TaskMeta = { task, variant: i + 1, of, title, branch: worktree.branch };
          await this.startVariant(this.opencodeClient(env.id), result, worktree.path, meta, variantTitle(title, labels[i], of), req.variants[i], req.prompt);
        } catch (err) {
          this.variantFailed(id, title, i, worktree.branch, result, err);
        }
      }),
    );
    const started = results.filter((r) => r.sessionId).length;
    this.log(id, `task ${title}: started ${started} of ${of} variant${of === 1 ? "" : "s"}`);
    this.monitors.get(id)?.reconcile?.();
    for (const r of results) if (r.envId) this.monitors.get(r.envId)?.reconcile?.();
    return { task, variants: results };
  }

  /** Creates a variant's session (recorded on the result at once) and sends the prompt. */
  private async startVariant(
    client: OpencodeClient,
    result: TaskVariantResult,
    directory: string,
    meta: TaskMeta,
    title: string,
    v: TaskVariantSpec,
    prompt: string,
  ): Promise<void> {
    const session = await client.createSession(directory, {
      title,
      ...(v.model ? { model: v.model } : {}),
      ...(v.agent ? { agent: v.agent } : {}),
      metadata: { opendevhub: meta },
    });
    result.sessionId = session.id;
    await client.prompt(session.id, prompt, undefined, directory);
  }

  private variantFailed(id: ProjectId, title: string, i: number, branch: string | undefined, result: TaskVariantResult, err: unknown): void {
    result.error = err instanceof Error ? err.message : String(err);
    this.log(id, `task ${title}: variant ${i + 1}${branch ? ` (${branch})` : ""} failed: ${result.error}`);
    if (err instanceof CommandError) for (const line of err.tail) this.log(id, line);
  }
```

- [ ] **Step 5: Remove containers with worktrees** — in `removeWorktree`, right after the `unknown worktree` check:

```ts
const rec = this.deps.store
  .environments(id)
  .find((e) => e.worktree.path === worktreePath);
if (rec) {
  const env = this.taskEnv(p, rec);
  try {
    await this.exclusiveEnv(env, () => this.destroyEnv(env));
  } catch (err) {
    if (err instanceof BusyError) throw err;
    throw new UnavailableError(
      `kept the worktree: its container could not be removed (${err instanceof Error ? err.message : String(err)})`
    );
  }
}
```

In `pickVariant`'s removal loop, before `await this.deps.worktrees.remove(p, ws, dir, true);` (its own `try`):

```ts
const rec = this.deps.store
  .environments(id)
  .find((e) => e.worktree.path === dir);
if (rec) {
  const env = this.taskEnv(p, rec);
  try {
    await this.exclusiveEnv(env, () => this.destroyEnv(env));
  } catch (err) {
    result.errors.push(
      `${wt.branch ?? dir}: kept — its container could not be removed: ${fail(err)}`
    );
    continue;
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run test/server && pnpm typecheck` Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/tasks.ts src/server/orchestrator.ts test/server/tasks.test.ts test/server/orchestrator.test.ts
git commit -m "feat: tasks can run each variant in its own container; removing a worktree removes its container"
```

### Task 12: `<envId>.localhost`, routes and wiring

**Files:**

- Modify: `src/server/hosts.ts`, `src/server/server.ts`, `src/server/proxy.ts`, `src/server/cli.ts`, `src/server/dashboard-api.ts`
- Test: `test/server/hosts.test.ts`, `test/server/cli.test.ts`, `test/server/dashboard-api.test.ts`

**Interfaces:**

- Consumes: `createEnv`, `startEnv`, `stopEnv`, `removeEnv`, `opencodeAddress` (Task 10); `Images` (Task 8); `EnvFiles`, `stateDir`, `Config.projects` (Task 6).
- Produces: `HostRoute = { kind: "dashboard" } | { kind: "env"; envId: string } | { kind: "reject" }`; `proxyTargets(store, orchestrator): ResolveTarget` exported from `cli.ts`; routes `POST /api/projects/:id/envs` `{ path }` → `{ envId }`, `POST /api/projects/:id/envs/:env/start|stop` → 202, `POST /api/projects/:id/envs/:env/remove` → `{ ok: true }`.

- [ ] **Step 1: Write the failing tests** — in `test/server/hosts.test.ts`, change the two `{ kind: "project", projectId: "demo-abc123" }` expectations to `{ kind: "env", envId: "demo-abc123" }` and add the row `["demo-abc123-feat-0a1b.localhost:7777", { kind: "env", envId: "demo-abc123-feat-0a1b" }],`.

Add to `test/server/cli.test.ts` (import `proxyTargets` from `../../src/server/cli` and `StateStore`):

```ts
describe("proxyTargets", () => {
  it("proxies to a running environment's opencode, main or task", () => {
    const store = new StateStore({
      port: 7777,
      persisted: { projects: {} },
      persist: () => {},
    });
    store.updateRuntime("p-feat-0a1b", {
      containerState: "running",
      password: "pw",
    });
    const addresses: Record<string, { host: string; port: number }> = {
      "p-feat-0a1b": { host: "172.17.0.10", port: 4096 },
    };
    const resolve = proxyTargets(store, {
      opencodeAddress: (id: string) => addresses[id],
    });
    expect(resolve("p-feat-0a1b")).toEqual({
      host: "172.17.0.10",
      port: 4096,
      password: "pw",
    });
    expect(resolve("p")).toBeUndefined();
  });
});
```

In `test/server/dashboard-api.test.ts`, add to the orchestrator fake in `setup`:

```ts
    createEnv: vi.fn(async (_id: string, _path: string) => ({ envId: "demo-abc123-x-0a1b" })),
    startEnv: vi.fn((_id: string, _env: string) => Promise.resolve()),
    stopEnv: vi.fn((_id: string, _env: string) => Promise.resolve()),
    removeEnv: vi.fn(async (_id: string, _env: string) => {}),
```

and the test:

```ts
it("creates, starts, stops and removes a worktree's own container", async () => {
  const { app, orchestrator } = setup();
  const post = (url: string, body?: unknown) =>
    app.request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  const created = await post(`/api/projects/${project.id}/envs`, {
    path: "/w/x",
  });
  expect(await created.json()).toEqual({ envId: "demo-abc123-x-0a1b" });
  expect(orchestrator.createEnv).toHaveBeenCalledWith(project.id, "/w/x");
  expect((await post(`/api/projects/${project.id}/envs/e1/start`)).status).toBe(
    202
  );
  expect(orchestrator.startEnv).toHaveBeenCalledWith(project.id, "e1");
  expect((await post(`/api/projects/${project.id}/envs/e1/stop`)).status).toBe(
    202
  );
  expect(orchestrator.stopEnv).toHaveBeenCalledWith(project.id, "e1");
  expect(
    (await post(`/api/projects/${project.id}/envs/e1/remove`)).status
  ).toBe(200);
  expect(orchestrator.removeEnv).toHaveBeenCalledWith(project.id, "e1");
  orchestrator.startEnv.mockImplementationOnce(() => {
    throw new NotFoundError("e9", "environment");
  });
  expect((await post(`/api/projects/${project.id}/envs/e9/start`)).status).toBe(
    404
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/server/hosts.test.ts test/server/cli.test.ts test/server/dashboard-api.test.ts` Expected: FAIL.

- [ ] **Step 3: Hosts and proxy** — in `src/server/hosts.ts`:

```ts
/** `<envId>.localhost` reaches an environment's opencode; a main environment's id is its project's. */
export type HostRoute =
  | { kind: "dashboard" }
  | { kind: "env"; envId: string }
  | { kind: "reject" };
```

and return `{ kind: "env", envId: label }`. In `src/server/server.ts`, check `route.kind === "env"` and pass `route.envId` (both in the request handler and the upgrade handler). In `src/server/proxy.ts`, rename the `projectId` parameters of `ResolveTarget`, `proxyRequest` and `proxyUpgrade` to `envId`, and change the 503 page to `sendPage(res, 503, "Not running", "Start it from the dashboard, then reload this page.", dashboardUrl)`.

- [ ] **Step 4: Wiring** — in `src/server/cli.ts`, import `EnvFiles`, `Images`, `stateDir`, `type ResolveTarget` from `./proxy`, and `type StateStore`. Add:

```ts
/** The proxy's upstream for `<envId>.localhost`: a running environment's opencode, main or task. */
export function proxyTargets(
  store: Pick<StateStore, "runtime">,
  orchestrator: Pick<Orchestrator, "opencodeAddress">
): ResolveTarget {
  return (envId) => {
    const rt = store.runtime(envId);
    const address = orchestrator.opencodeAddress(envId);
    if (rt.containerState !== "running" || !address || !rt.password)
      return undefined;
    return { ...address, password: rt.password };
  };
}
```

In `main`, create `const git = new GitOps({ containers });` before the orchestrator and pass to it:

```ts
    git,
    images: new Images({ run: spawnRunner, containers, git }),
    envFiles: new EnvFiles(path.join(stateDir(), "envs")),
    projectSettings: (p) => loadConfig(dir).projects?.[p.path],
```

(replacing `git: new GitOps({ containers })`), and pass `resolveTarget: proxyTargets(store, orchestrator)` to `startServer`.

- [ ] **Step 5: Routes** — in `src/server/dashboard-api.ts`, add `"createEnv" | "startEnv" | "stopEnv" | "removeEnv"` to `DashboardOrchestrator`, and after the worktree routes:

```ts
// A worktree's own container.
app.post("/api/projects/:id/envs", (c) =>
  json(c, (id, b) => orchestrator.createEnv(id, str(b.path) ?? ""))
);
const envActions = {
  start: (id: string, envId: string) => orchestrator.startEnv(id, envId),
  stop: (id: string, envId: string) => orchestrator.stopEnv(id, envId),
} as const;
for (const [route, run] of Object.entries(envActions)) {
  app.post(`/api/projects/:id/envs/:env/${route}`, (c) => {
    if (store.preflight().errors.length > 0) {
      return c.json({ error: store.preflight().errors.join("; ") }, 412);
    }
    try {
      run(c.req.param("id"), c.req.param("env")).catch(() => {});
      return c.json({ accepted: true }, 202);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : String(err) },
        errorStatus(err)
      );
    }
  });
}
app.post("/api/projects/:id/envs/:env/remove", (c) =>
  json(c, (id) => orchestrator.removeEnv(id, c.req.param("env") ?? ""))
);
```

- [ ] **Step 6: Run the tests**

Run: `pnpm test && pnpm typecheck` Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server test/server
git commit -m "feat: proxy <envId>.localhost and routes to create, start, stop and remove a worktree's container"
```

---

### Task 13: Web data — env calls, helpers and per-environment session links

**Files:**

- Modify: `src/web/api.ts`, `src/web/derive.ts`
- Modify: `src/web/components/ProjectActions.tsx`, `SessionList.tsx`, `CommandPalette.tsx`, `PendingCards.tsx`, `src/web/pages/ProjectTask.tsx`
- Test: `test/web/api.test.ts`, `test/web/derive.test.ts`

**Interfaces:**

- Consumes: the routes of Task 12; `ProjectView.environments` (Tasks 1, 9).
- Produces: `createEnv(projectId, path): Promise<{ envId: string }>`, `envAction(projectId, envId, "start" | "stop"): Promise<void>`, `removeEnv(projectId, envId): Promise<unknown>`; `envOfDirectory(view, directory): EnvironmentView | undefined`, `openUrlOf(view, envId?): string`, `sessionHref(view, session): string`, `envTone(env): Tone`; `containerShellCommand` uses the directory's environment; `openSessionTab(view, create, directory?)`.

- [ ] **Step 1: Write the failing tests** — add to `test/web/api.test.ts` (import `createEnv`, `envAction`, `removeEnv`):

```ts
describe("environment API", () => {
  it("creates, starts, stops and removes a worktree's container", async () => {
    const fetchMock = stubFetch(200, { envId: "e1" });
    expect(await createEnv("demo-1", "/w/x")).toEqual({ envId: "e1" });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/projects/demo-1/envs");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      path: "/w/x",
    });
    await envAction("demo-1", "e1", "stop");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/projects/demo-1/envs/e1/stop"
    );
    expect(fetchMock.mock.calls[1][1]?.method).toBe("POST");
    await removeEnv("demo-1", "e1");
    expect(fetchMock.mock.calls[2][0]).toBe(
      "/api/projects/demo-1/envs/e1/remove"
    );
  });
});
```

Add to `test/web/derive.test.ts` (import `envOfDirectory`, `envTone`, `openUrlOf`, `sessionHref`, and `type EnvironmentView`):

```ts
describe("task environments", () => {
  const env: EnvironmentView = {
    id: "p-feat-0a1b",
    worktree: {
      path: "/w.worktrees/feat",
      hostPath: "/p.worktrees/feat",
      branch: "feat",
    },
    runtime: {
      projectId: "p",
      containerState: "running",
      opencode: "healthy",
      containerName: "task_c",
      remoteUser: "node",
    },
    openUrl: "http://p-feat-0a1b.localhost:7777/",
  };
  const view = (): ProjectView => ({
    ...snap({}).projects[0],
    environments: [env],
  });

  it("finds a checkout's environment and its opencode URL", () => {
    expect(envOfDirectory(view(), "/w.worktrees/feat")?.id).toBe(env.id);
    expect(envOfDirectory(view(), "/w")).toBeUndefined();
    expect(openUrlOf(view(), env.id)).toBe(env.openUrl);
    expect(openUrlOf(view(), undefined)).toBe("http://p.localhost:7777/");
    expect(openUrlOf(view(), "gone")).toBe("http://p.localhost:7777/");
  });

  it("links a session to the opencode that runs it", () => {
    const s = {
      id: "ses_1",
      projectId: "p",
      envId: env.id,
      title: "t",
      directory: "/w.worktrees/feat",
      updatedAt: 1,
      status: "idle" as const,
    };
    expect(sessionHref(view(), s)).toMatch(
      /^http:\/\/p-feat-0a1b\.localhost:7777\/server\/.+\/session\/ses_1$/
    );
    expect(sessionHref(view(), { ...s, envId: undefined })).toMatch(
      /^http:\/\/p\.localhost:7777\//
    );
  });

  it("opens a shell in the worktree's own container", () => {
    expect(containerShellCommand(view(), "/w.worktrees/feat")).toContain(
      " task_c "
    );
  });

  it("tones a container by its state", () => {
    expect(envTone(env)).toBe("ok");
    expect(
      envTone({
        ...env,
        runtime: { ...env.runtime, containerState: "starting" },
      })
    ).toBe("busy");
    expect(
      envTone({ ...env, runtime: { ...env.runtime, opencode: "unhealthy" } })
    ).toBe("error");
    expect(
      envTone({
        ...env,
        runtime: { ...env.runtime, containerState: "stopped" },
      })
    ).toBe("off");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run test/web/api.test.ts test/web/derive.test.ts` Expected: FAIL — missing exports.

- [ ] **Step 3: Implement `api.ts`**:

```ts
export function createEnv(
  projectId: string,
  path: string
): Promise<{ envId: string }> {
  return postJson(projectId, "envs", { path }, "create container");
}

export async function envAction(
  projectId: string,
  envId: string,
  action: "start" | "stop"
): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/envs/${encodeURIComponent(envId)}/${action}`,
    { method: "POST" }
  );
  if (!res.ok) throw await failure(res, `${action} container`);
}

export function removeEnv(projectId: string, envId: string): Promise<unknown> {
  return postJson(
    projectId,
    `envs/${encodeURIComponent(envId)}/remove`,
    {},
    "remove container"
  );
}
```

- [ ] **Step 4: Implement `derive.ts`** — import `EnvironmentView`, `SessionSummary` (types) and `sessionUrl` from `../shared/urls`; add:

```ts
/** The worktree's own container, when it has one. */
export function envOfDirectory(
  view: ProjectView,
  directory: string
): EnvironmentView | undefined {
  return view.environments.find((e) => e.worktree.path === directory);
}

/** The opencode URL of an environment; the project's for the main one or one that is gone. */
export function openUrlOf(
  view: ProjectView,
  envId: string | undefined
): string {
  return (
    (envId && view.environments.find((e) => e.id === envId)?.openUrl) ||
    view.openUrl
  );
}

/** A session in the opencode that runs it. */
export function sessionHref(
  view: ProjectView,
  session: SessionSummary
): string {
  return sessionUrl(openUrlOf(view, session.envId), session.id);
}

export function envTone(env: EnvironmentView): Tone {
  const { containerState, opencode } = env.runtime;
  if (
    containerState === "error" ||
    (containerState === "running" && opencode === "unhealthy")
  )
    return "error";
  if (
    containerState === "starting" ||
    containerState === "stopping" ||
    opencode === "starting"
  )
    return "busy";
  return containerState === "running" ? "ok" : "off";
}
```

In `containerShellCommand`, replace the first line with:

```ts
const { containerName, remoteUser } = (envOfDirectory(view, directory) ?? view)
  .runtime;
```

- [ ] **Step 5: Use the right opencode for each session** — replace each `sessionUrl(view.openUrl, <session>.id)` with `sessionHref(view, <session>)`: `CommandPalette.tsx:63` (`session`), `PendingCards.tsx:115` (`session`), `ProjectTask.tsx:131` (`s`), `ProjectActions.tsx:60` (`latest`). In `SessionList.tsx`, pass `openUrl={openUrlOf(view, session.envId)}` to `SessionRow`. In `ProjectActions.tsx`, change `openSessionTab` to:

```ts
export async function openSessionTab(
  view: ProjectView,
  create: () => Promise<string | undefined>,
  directory?: string
): Promise<void> {
  const tab = window.open("about:blank", "_blank");
  try {
    const id = await create();
    const base = directory
      ? openUrlOf(view, envOfDirectory(view, directory)?.id)
      : view.openUrl;
    if (id && tab) tab.location.href = sessionUrl(base, id);
    else tab?.close();
  } catch (err) {
    tab?.close();
    throw err;
  }
}
```

Drop `sessionUrl` imports that become unused.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run test/web && pnpm typecheck` Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/web test/web
git commit -m "feat: web calls for worktree containers; sessions open in the opencode that runs them"
```

### Task 14: UI — Own container on worktrees, Ports by environment, the task dialog and the task page

**Files:**

- Create: `src/web/components/EnvBadge.tsx`
- Modify: `src/web/pages/ProjectWorktrees.tsx`, `src/web/pages/ProjectPage.tsx`, `src/web/components/NewTaskDialog.tsx`, `src/web/pages/ProjectTask.tsx`, `src/web/styles.css`

**Interfaces:**

- Consumes: `createEnv`, `envAction`, `removeEnv`, `envOfDirectory`, `envTone`, `openSessionTab(view, create, directory)` (Task 13).
- Produces: `EnvBadge({ env })`.

There are no component tests in this repository; this task is checked with `pnpm typecheck`, `pnpm build` and the running app (Step 7).

- [ ] **Step 1: `EnvBadge`** — `src/web/components/EnvBadge.tsx`:

```tsx
import type { EnvironmentView } from "../../shared/types";
import { envTone } from "../derive";
import { STATE_LABEL, StatusDot } from "./Status";

/** A worktree's own container: a dot and its state. */
export function EnvBadge({ env }: { env: EnvironmentView }) {
  const { containerState, opencode, error } = env.runtime;
  const label =
    containerState === "running" && opencode === "unhealthy"
      ? "opencode down"
      : STATE_LABEL[containerState];
  return (
    <span className="env-badge" title={error ?? `Own container (${env.id})`}>
      <StatusDot tone={envTone(env)} label={label} /> Own container · {label}
    </span>
  );
}
```

Append to `src/web/styles.css`:

```css
.env-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  white-space: nowrap;
  font-size: 12px;
}
.ports-env {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 13px;
  margin: 1rem 0 0.4rem;
}
```

- [ ] **Step 2: Worktrees tab** — in `src/web/pages/ProjectWorktrees.tsx`, import `createEnv`, `envAction`, `removeEnv`, `envOfDirectory`, `EnvBadge`. Add `const unsupported = view.isolation?.unsupported;`. Add a `<th>Container</th>` after `<th>Sessions</th>`; in the main checkout row add `<td className="muted">Project's</td>` after the sessions cell. Make `newSession` pass the directory: `openSessionTab(view, () => startSession(project.id, directory, title), directory)`. Replace `remove` with:

```tsx
const remove = (path: string, name: string) => {
  const own = envOfDirectory(view, path);
  const what = own
    ? "Its folder, its container and the container's sessions are deleted"
    : "Its folder is deleted";
  if (!confirm(`Remove the worktree ${name}? ${what}; the branch is kept.`))
    return;
  busy(path, async () => {
    try {
      await removeWorktree(project.id, path, false);
    } catch (err) {
      if (!(err instanceof Error) || !/--force/.test(err.message)) throw err;
      if (
        !confirm(
          `${name} has uncommitted or untracked changes. Remove it anyway and discard them?`
        )
      )
        return;
      await removeWorktree(project.id, path, true);
    }
  });
};
```

In the worktree rows, compute `const env = envOfDirectory(view, w.path);` and `const sessionsReady = env ? env.runtime.opencode === "healthy" : canOpen;`. Add a cell after the sessions cell:

```tsx
<td>{env ? <EnvBadge env={env} /> : <span className="muted">Shared</span>}</td>
```

Change the row's New session button to `disabled={!sessionsReady || !!pending}`, and add before the `OpenInMenu`:

```tsx
{
  env ? (
    <>
      {env.runtime.containerState === "running" ? (
        <button
          className="small"
          disabled={!!pending}
          onClick={() =>
            busy(`env:${env.id}`, () => envAction(project.id, env.id, "stop"))
          }
        >
          Stop container
        </button>
      ) : (
        <button
          className="small"
          disabled={
            !running || !!pending || env.runtime.containerState === "starting"
          }
          onClick={() =>
            busy(`env:${env.id}`, () => envAction(project.id, env.id, "start"))
          }
        >
          Start container
        </button>
      )}
      <button
        className="small ghost"
        disabled={!!pending || env.runtime.containerState === "starting"}
        onClick={() => {
          if (
            confirm(
              `Remove the container of ${name}? Its sessions are deleted; the worktree and its files stay.`
            )
          )
            busy(`env:${env.id}`, () => removeEnv(project.id, env.id));
        }}
      >
        Remove container
      </button>
    </>
  ) : (
    <button
      className="small"
      disabled={!running || !!pending || !!unsupported || !w.hostPath}
      title={
        unsupported ??
        (w.hostPath
          ? "Run this worktree in its own devcontainer"
          : "Only worktrees in the mounted folder can")
      }
      onClick={() => busy(`env:${w.path}`, () => createEnv(project.id, w.path))}
    >
      Own container
    </button>
  );
}
```

- [ ] **Step 3: Ports tab by environment** — in `src/web/pages/ProjectPage.tsx`, change the Ports count to `runtime.ports?.length ?? 0` plus `view.environments.reduce((n, e) => n + (e.runtime.ports?.length ?? 0), 0)` (use the page's `view` variable). Replace `ProjectPorts` with:

```tsx
export function ProjectPorts() {
  const view = useView();
  const groups = [
    {
      key: view.project.id,
      branch: undefined as string | undefined,
      runtime: view.runtime,
    },
    ...view.environments.map((e) => ({
      key: e.id,
      branch: e.worktree.branch,
      runtime: e.runtime,
    })),
  ].filter((g) => (g.runtime.ports?.length ?? 0) > 0);
  if (groups.length === 0) {
    return (
      <div className="empty">
        <h2>No forwarded ports</h2>
        <p className="muted">
          Add <code>forwardPorts</code> to the project's devcontainer.json to
          reach its apps from <code>localhost</code>.
        </p>
      </div>
    );
  }
  return (
    <div className="tab-body">
      {groups.map((g) => (
        <section key={g.key}>
          {g.branch && (
            <h3 className="ports-env">
              <Icon name="branch" size={12} /> {g.branch}{" "}
              <span className="muted">· own container</span>
            </h3>
          )}
          {g.runtime.relay && (
            <p
              className={`note${g.runtime.relay === "unavailable" ? " note-warn" : ""}`}
            >
              {g.runtime.relay === "active"
                ? "Connections go through a relay inside the container, so apps bound to localhost there are reachable."
                : "No relay in the container: only apps listening on 0.0.0.0 are reachable. See the Logs tab for why."}
            </p>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Container</th>
                  <th>Local</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {g.runtime.ports!.map((p) => (
                  <PortRow
                    key={
                      p.status === "skipped"
                        ? `s-${p.entry}`
                        : `${p.status}-${p.containerPort}`
                    }
                    port={p}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: New task dialog** — in `src/web/components/NewTaskDialog.tsx`, import `type Isolation`. Add state `const [environment, setEnvironment] = useState<Isolation>();` and reset it in the project `<select>`'s `onChange` (`setEnvironment(undefined);`). After `effectiveWhere`:

```tsx
const isolation = view?.isolation;
const chosenEnv: Isolation = isolation?.unsupported
  ? "shared"
  : (environment ?? isolation?.default ?? "shared");
```

In `submit`'s request add `...(worktree ? { environment: chosenEnv } : {}),` after `where`. After the "Where" fieldset:

```tsx
{
  effectiveWhere === "worktree" && (
    <fieldset className="task-where">
      <legend>Environment</legend>
      <label>
        <input
          type="radio"
          name="environment"
          checked={chosenEnv === "shared"}
          onChange={() => setEnvironment("shared")}
        />{" "}
        Shared container
      </label>
      <label title={isolation?.unsupported}>
        <input
          type="radio"
          name="environment"
          checked={chosenEnv === "isolated"}
          disabled={!!isolation?.unsupported}
          onChange={() => setEnvironment("isolated")}
        />{" "}
        Own container
      </label>
      {isolation?.unsupported && (
        <span className="muted">{isolation.unsupported}</span>
      )}
    </fieldset>
  );
}
```

- [ ] **Step 5: Task page** — in `src/web/pages/ProjectTask.tsx`, import `EnvBadge` and `envOfDirectory`; in each variant column compute `const env = envOfDirectory(view, s.directory);` and add to the `task-facts` list after Branch:

```tsx
                <dt>Container</dt>
                <dd>{env ? <EnvBadge env={env} /> : "Shared"}</dd>
```

- [ ] **Step 6: Typecheck and build**

Run: `pnpm typecheck && pnpm build && pnpm test` Expected: PASS.

- [ ] **Step 7: See it working** — use the `run` skill (or `pnpm dev` plus `pnpm dev:web`) against a project with a mounted worktree:
  - The Worktrees tab shows "Shared" and an **Own container** button; clicking it shows "Own container · Starting…", then "Running"; **Stop container**/**Start container** toggle; **Remove container** returns the row to "Shared".
  - New session on that row opens `http://<envId>.localhost:7777/…`.
  - The Ports tab lists the worktree's ports under its branch.
  - The New task dialog shows Environment; with "Own container", the task page shows the container badge per variant.

- [ ] **Step 8: Commit**

```bash
git add src/web
git commit -m "feat: Own container on worktrees, ports by environment and the Environment choice for tasks"
```

### Task 15: End-to-end test with real containers, and the README

**Files:**

- Create: `test/e2e/environments.e2e.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: everything above.

- [ ] **Step 1: Write the e2e test** — `test/e2e/environments.e2e.ts`:

```ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { Containers, envLabels } from "../../src/server/containers";
import { EditorLauncher } from "../../src/server/editors";
import { EnvFiles } from "../../src/server/env-files";
import { spawnRunner } from "../../src/server/exec";
import { Gateway } from "../../src/server/gateway";
import { GitOps } from "../../src/server/git";
import { projectId } from "../../src/server/ids";
import { Images } from "../../src/server/images";
import { Network, parseRouteMode } from "../../src/server/network";
import { OpencodeClient } from "../../src/server/opencode/client";
import { OpencodeRuntime } from "../../src/server/opencode/runtime";
import { Orchestrator } from "../../src/server/orchestrator";
import { PortForwarder } from "../../src/server/port-forwarder";
import { Publisher } from "../../src/server/publish";
import { RelayRuntime } from "../../src/server/relay/runtime";
import { StateStore } from "../../src/server/state";
import { Worktrees } from "../../src/server/worktrees";
import type { Project } from "../../src/shared/types";

const PROMPT = "Reply with the word ok. Do not change any files.";
const LIFECYCLE = ["onCreate", "updateContent", "postCreate", "postStart"];

const devcontainer = (extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      build: { dockerfile: "Dockerfile" },
      onCreateCommand: "echo onCreate >> /tmp/lifecycle.log",
      updateContentCommand: "echo updateContent >> /tmp/lifecycle.log",
      postCreateCommand: "echo postCreate >> /tmp/lifecycle.log",
      postStartCommand: "echo postStart >> /tmp/lifecycle.log",
      forwardPorts: [3000],
      customizations: { opendevhub: { isolation: "isolated" } },
      ...extra,
    },
    null,
    2
  );

describe.skipIf(!process.env.OPENDEVHUB_E2E)(
  "e2e: per-task environments",
  () => {
    it("runs isolated tasks side by side, each in its own container with its own ports", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-envs-"));
      const repo = path.join(tmp, "envs-demo");
      fs.mkdirSync(path.join(repo, ".devcontainer"), { recursive: true });
      fs.writeFileSync(
        path.join(repo, ".devcontainer/Dockerfile"),
        "FROM mcr.microsoft.com/devcontainers/javascript-node:22\nRUN npm i -g @opencode/cli@2\n"
      );
      fs.writeFileSync(
        path.join(repo, ".devcontainer/devcontainer.json"),
        devcontainer()
      );
      const hostGit = (...args: string[]) =>
        execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      hostGit("init", "-q", "-b", "main");
      hostGit("config", "user.name", "e2e");
      hostGit("config", "user.email", "e2e@example.com");
      hostGit("add", "-A");
      hostGit("commit", "-q", "-m", "init");

      const project: Project = {
        id: projectId(repo),
        name: "envs-demo",
        path: repo,
        devcontainerPath: path.join(repo, ".devcontainer/devcontainer.json"),
      };
      const store = new StateStore({
        port: 0,
        persisted: { projects: {} },
        persist: () => {},
      });
      const containers = new Containers(spawnRunner);
      const git = new GitOps({ containers });
      const envFiles = new EnvFiles(path.join(tmp, "envs"));
      const clientFor = (ep: { baseUrl: string; password: string }) =>
        new OpencodeClient(ep);
      const runtime = new OpencodeRuntime({ containers, clientFor });
      const orch = new Orchestrator({
        store,
        containers,
        runtime,
        forwarder: new PortForwarder(),
        relay: new RelayRuntime({ containers }),
        network: new Network({
          mode: parseRouteMode(process.env.OPENDEVHUB_ROUTE),
          gateway: new Gateway({ run: spawnRunner }),
        }),
        worktrees: new Worktrees({ containers, run: spawnRunner }),
        git,
        images: new Images({ run: spawnRunner, containers, git }),
        envFiles,
        publisher: new Publisher({
          containers,
          run: spawnRunner,
          forges: { all: () => ({}), remember: () => {} },
        }),
        editors: new EditorLauncher([]),
        clientFor,
        roots: () => [],
        scan: async () => [project],
      });
      orch.onLog((_id, line) => console.log(`[e2e envs] ${line}`));
      const targetOf = (envId: string) => {
        const rec = store.environment(envId)!;
        return {
          id: envId,
          path: rec.worktree.hostPath,
          idLabels: envLabels(envId, project.id),
          overrideConfig: envFiles.path(envId),
        };
      };
      const lifecycle = async (envId: string) =>
        (
          await containers.exec(targetOf(envId), ["cat", "/tmp/lifecycle.log"])
        ).stdout
          .split("\n")
          .filter(Boolean);

      try {
        await orch.rescan();
        await orch.start(project.id);
        expect(store.runtime(project.id)).toMatchObject({
          containerState: "running",
          opencode: "healthy",
        });
        expect(store.snapshot().projects[0].isolation).toEqual({
          default: "isolated",
        });
        const mainContainer = store.runtime(project.id).containerId;
        const mainLog = (
          await containers.exec(project, ["cat", "/tmp/lifecycle.log"])
        ).stdout;

        const two = await orch.createTask(project.id, {
          prompt: PROMPT,
          title: "e2e iso",
          variants: [{}, {}],
        });
        expect(two.variants.map((v) => v.error)).toEqual([
          undefined,
          undefined,
        ]);
        const envIds = two.variants.map((v) => v.envId!);
        expect(new Set(envIds).size).toBe(2);
        for (const id of envIds) {
          expect(store.runtime(id)).toMatchObject({
            containerState: "running",
            opencode: "healthy",
          });
          // image mode: every lifecycle command, once, in the task's own container
          expect(await lifecycle(id)).toEqual(LIFECYCLE);
        }
        expect(
          new Set(envIds.map((id) => store.environment(id)!.image!.ref)).size
        ).toBe(1);
        await vi.waitFor(
          () =>
            expect(
              envIds.every((id) =>
                store.sessionsOf(project.id).some((s) => s.envId === id)
              )
            ).toBe(true),
          { timeout: 30_000, interval: 500 }
        );

        // Both serve their own port 3000, on different host ports.
        const hostPorts: number[] = [];
        for (const id of envIds) {
          await containers.exec(targetOf(id), [
            "sh",
            "-c",
            `nohup node -e "require('http').createServer((q, r) => r.end('${id}')).listen(3000, '127.0.0.1')" < /dev/null > /tmp/web.log 2>&1 &`,
          ]);
          const fwd = store
            .runtime(id)
            .ports?.find(
              (p) => p.status === "forwarded" && p.containerPort === 3000
            );
          expect(fwd?.status).toBe("forwarded");
          hostPorts.push(fwd?.status === "forwarded" ? fwd.hostPort : 0);
        }
        expect(hostPorts[0]).not.toBe(hostPorts[1]);
        for (const [i, id] of envIds.entries()) {
          await vi.waitFor(
            async () =>
              expect(
                await (await fetch(`http://127.0.0.1:${hostPorts[i]}/`)).text()
              ).toBe(id),
            {
              timeout: 15_000,
              interval: 500,
            }
          );
        }

        // A branch that changes .devcontainer gets its own image.
        const { worktree } = await orch.createWorktree(project.id, {
          branch: "devc",
        });
        fs.writeFileSync(
          path.join(worktree.hostPath!, ".devcontainer/devcontainer.json"),
          devcontainer({ containerEnv: { E2E: "1" } })
        );
        await containers.exec(project, [
          "git",
          "-C",
          worktree.path,
          "commit",
          "-qam",
          "change the devcontainer",
        ]);
        const { envId: devc } = await orch.createEnv(project.id, worktree.path);
        await vi.waitFor(
          () => expect(store.runtime(devc).opencode).toBe("healthy"),
          { timeout: 10 * 60_000, interval: 1000 }
        );
        expect(store.environment(devc)!.image!.ref).not.toBe(
          store.environment(envIds[0])!.image!.ref
        );

        // A warm environment (image already built) starts in under 10 s.
        const { worktree: warm } = await orch.createWorktree(project.id, {
          branch: "warm",
        });
        const t0 = Date.now();
        const { envId: warmId } = await orch.createEnv(project.id, warm.path);
        await vi.waitFor(
          () => expect(store.runtime(warmId).opencode).toBe("healthy"),
          { timeout: 60_000, interval: 200 }
        );
        expect(Date.now() - t0).toBeLessThan(10_000);

        // Picking one variant removes the other's container with its worktree.
        const [keep, drop] = two.variants;
        const dropContainer = store.runtime(drop.envId!).containerId!;
        const picked = await orch.pickVariant(
          project.id,
          two.task,
          keep.sessionId!,
          true
        );
        expect(picked.errors).toEqual([]);
        expect(picked.removed).toEqual([drop.directory]);
        expect(store.environment(drop.envId!)).toBeUndefined();
        expect(await containers.inspect(dropContainer)).toBeUndefined();

        // The main environment was never touched.
        expect(store.runtime(project.id).containerId).toBe(mainContainer);
        expect(
          (await containers.exec(project, ["cat", "/tmp/lifecycle.log"])).stdout
        ).toBe(mainLog);
      } finally {
        for (const e of store.environments(project.id))
          await orch.removeEnv(project.id, e.id).catch(() => {});
        await orch.stop(project.id).catch(() => {});
        await orch.shutdown();
        const images = execFileSync(
          "docker",
          ["images", "-q", `opendevhub/${project.id}`],
          { encoding: "utf8" }
        )
          .split(/\s+/)
          .filter(Boolean);
        if (images.length > 0)
          execFileSync("docker", ["image", "rm", "-f", ...images]);
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  }
);
```

- [ ] **Step 2: Run it**

Run: `pnpm test:e2e test/e2e/environments.e2e.ts` Expected: PASS (the first run builds two images and takes several minutes). Also run `pnpm test:e2e test/e2e/tasks.e2e.ts test/e2e/opendevhub.e2e.ts` to confirm the shared mode is unchanged.

- [ ] **Step 3: README** — add after the `## Worktrees` section of `README.md`:

````markdown
## Own containers for worktrees

A worktree can run in its own devcontainer, with its own opencode, processes, ports and `$HOME`, so parallel agents don't trip over each other's dev servers or databases. Use **Own container** on a row of the Worktrees tab, or choose **Environment: Own container** in the New task dialog.

- The container starts from an image built once per project and devcontainer config (`opendevhub/<project>:<key>-base`). All lifecycle commands run in each container, so a task gets its own `npm ci`.
- Make it the default for a project in `devcontainer.json`:

  ```jsonc
  "customizations": {
    "opendevhub": {
      "isolation": "isolated",            // "shared" (default) | "isolated"
      "keyFiles": ["package-lock.json"]   // files whose change means a new image
    }
  }
  ```

  or for a repo you don't own, in `~/.config/opendevhub/config.json`: `"projects": { "/path/to/repo": { "isolation": "isolated" } }`.

- Git commands (review, commit, merge, worktree add and remove) still run in the project's container, which has to be running.
- Removing a worktree's container deletes the sessions that ran in it; the worktree and its files stay.
````

and under `## Known limitations`:

```markdown
- Own containers don't support Docker Compose configs, `appPort`, `runArgs` that publish ports, host networking, or lifecycle commands that use `${containerWorkspaceFolder}`; such projects run tasks in the shared container and say why.
- A Dockerfile whose build context reaches outside `.devcontainer` can change without opendevhub noticing; remove the `opendevhub/<project>:*` images to force a rebuild.
```

- [ ] **Step 4: Commit**

```bash
git add test/e2e/environments.e2e.ts README.md
git commit -m "test: e2e for worktrees in their own containers; docs: own containers in the README"
```

---

## Self-review notes

- **Spec coverage (phases 1–2):** the Environment refactor (Tasks 1–4); the override config with `.git` mount, workspace, lifecycle stripping and `--name` removal (Task 5); image key and base image (Tasks 7–8); per-environment routes, relay, ports and monitor (Tasks 4, 10); `<envId>.localhost` (Task 12); configuration and per-project overrides (Tasks 5, 6, 10); the Compose/ports/host-network fallback with a message (Tasks 5, 10, 11); tasks choosing shared or isolated (Task 11); env badges, Ports grouped by environment, the dialog choice (Task 14); e2e (Task 15).
- **Deliberately later:** snapshot mode and the CLI version gate (phase 3); Restart/Recreate/Rebuild image, the outdated badge, idle stop, garbage collection and the opencode data volume (phase 4); session export/import and `maxRunningEnvs` (phase 5); Compose (phase 6). The "Preparing environment image…" progress is phase 3; in image mode a first build shows as "Starting…" with the build lines in the Logs tab.
