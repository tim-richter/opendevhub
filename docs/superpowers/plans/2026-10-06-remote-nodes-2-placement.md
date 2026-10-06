# Remote Nodes, Plan 2: Tasks on Nodes

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start isolated task variants on a node chosen in the task form. Have them work like local ones (sessions, permissions, ports, review, commit, update), bring their branches home, merge and publish them, and survive the node dropping and coming back.

**Architecture:** Each of the orchestrator's per-environment tools (Containers, the opencode and relay runtimes, Images, EnvFiles, Credentials, the network route, GitOps) is already built on a `Runner`. A **node kit** is the same set built on the node's `SshHost.run`, plus a `NodeRepo` that keeps the project's repository on the node. Every environment carries a `node`. The orchestrator resolves its kit per environment, and the local kit is the one it has today. The hub pushes the base branch into the node repo and creates the worktree there. The task container then mounts that worktree and the repo's `.git` exactly as a local task container does. `Nodes` reports nodes coming online and going offline, so the orchestrator adopts a node's containers or parks its environments.

**Tech Stack:** TypeScript (Node ≥ 22.13, ESM), Hono, vitest, React and Tailwind with shadcn/ui in `src/web`, OpenSSH, and git ≥ 2.48 on nodes. No new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-10-06-remote-nodes-design.md` (sections "Placement", "Code to the node and back", "Runtime"). Plan 1 (`2026-10-06-remote-nodes-1-foundation.md`) built `Host`, `SshHost`, `NodeConnection`, `Nodes`, `sshRoute` and the Nodes page. Plan 3 covers the Cleanup page per node, the project's default node, the opt-in e2e test, and docs for those.

All paths below are relative to `apps/opendevhub/` unless they start with `docs/`. Run commands from `apps/opendevhub/`. Work happens directly on `main`.

## Decisions beyond the spec

These fill gaps the spec leaves. Each is binding for this plan.

1. **The base is pushed as a branch of the same name** (`+<base>:refs/heads/<base>`), not as `refs/odh/base/<task>`. The new branch records it in `branch.<b>.opendevhubBase`, as locally. That way review, ahead/behind and Update from base run unchanged inside the remote container. A remote task therefore needs a base branch: the request's `base`, or the main checkout's current branch. A detached main checkout is refused with a 400.
2. **Node repo layout:** `<home>/.opendevhub/repos/<projectId>/<name>`, with worktrees in `<home>/.opendevhub/repos/<projectId>/<name>.worktrees/<dir>`. `<name>` is the basename of the project's workspace folder. That way the relative worktree links git writes on the node resolve inside the container, where the worktree sits at `<ws>.worktrees/<dir>` and `.git` at `<ws>/.git`.
3. **Publishing a remote variant brings its branch home and publishes from the main checkout.** The node repo has no remotes, so pushing from the node can't reach the forge. Merge into base also brings the branch home first.
4. **A node that isn't online answers `UnavailableError`** (HTTP 412, like every other "not running" error in this codebase), not 503.
5. **Removing a remote environment also removes its worktree and branch on the node.** They exist only for that environment, and nothing else lists them. A branch that was brought home stays in the local repository.
6. **Checks and Open in editor are not available for remote environments** in this plan. Checks say so, and the editor menu is hidden.
7. **Remote worktrees appear in the snapshot's `runtime.worktrees`** with `node` set and no `hostPath`, so the web's checkouts, routes and task views pick them up unchanged.
8. **Remote environment ids hash the node and the path** (`envIdFor(projectId, "<node>:<path>", branch)`), so they never collide with a local environment for the same container path.

## Global Constraints

- The machine opendevhub runs on is the node `local` (`LOCAL_NODE`). Records and requests omit `node` for it.
- Only `where: "worktree"`, `environment: "isolated"` tasks run on another node. Anything else with a `node` is a 400 `InvalidRequestError`.
- An unknown node is a 400 `InvalidRequestError` ("unknown node <id>"). A known node that isn't online is an `UnavailableError` with exactly "node <id> is unreachable".
- The node repo is never checked out: `git init -q` and then `git config receive.denyCurrentBranch ignore`.
- git on the node runs on the node itself through `SshHost.run`, never through the main container. git on the hub runs on this machine with the local runner, in the project's folder.
- The hub's git reaches the node through the ControlMaster: `GIT_SSH_COMMAND="ssh -S <quoted control> -o BatchMode=yes"` and `GIT_TERMINAL_PROMPT=0`.
- Worktrees on the node use `git worktree add --relative-paths`.
- Bring home never moves a local branch that isn't an ancestor of the remote one, or one checked out in the main checkout.
- UI is Tailwind with components from shadcn/ui (`@/components/ui/*`).

## Review Focus

1. **A transient ssh failure during the periodic refresh** (`docker inspect` over ssh exits 255) must leave a remote environment running, not mark it stopped. Owned by Task 3 (inspect throws on 255) and Task 6 (refresh skips).
2. **A remote environment and a local worktree at the same container path** must stay distinct: env ids hash the node (Task 7), and `createWorktree` refuses a path a remote environment holds (Task 7).
3. **Bring home onto a local branch that diverged, or that is checked out**, must refuse and leave the local branch alone. The temporary ref must be deleted either way. Owned by Task 4.
4. **A node going offline mid-session** must not break project-wide actions. Stopping the project and the refresh skip that node's environments, and actions on them fail with "node <id> is unreachable". Owned by Tasks 5 and 6.
5. **Base names with slashes** (`origin/main`, `feature/x`) and control socket paths with spaces must reach git unchanged. Owned by Task 4 (exact argument and env assertions).

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/server/host.ts`, `src/server/ssh.ts` (modify) | `Host.home`; `SshHost.home` set once connected. |
| `src/server/node-connection.ts` (modify) | Reads `$HOME` after the master is up; exposes `target`. |
| `src/server/nodes.ts` (modify) | `connection(id)`; `onOnline` and `onOffline` callbacks. |
| `src/shared/types.ts` (modify) | `EnvironmentView.node`, `Worktree.node`, `TaskRequest.node`. |
| `src/server/state.ts`, `src/server/config.ts` (modify) | `EnvRecord.node` persisted; remote worktrees in the snapshot. |
| `src/server/tasks.ts` (modify) | `node` in task requests. |
| `src/server/containers.ts` (modify) | `inspect` throws when ssh fails (exit 255). |
| `src/server/git.ts` (modify) | GitOps takes any `ExecTarget`; `hostHeadObjects` for a node's own git. |
| `src/server/images.ts` (modify) | Image key objects come from an `objects` function. |
| `src/server/env-files.ts` (modify) | Optional `Host` to write and remove files on a node. |
| `src/server/node-repo.ts` (new) | The project's repo on a node: layout, ensure, branches, push base, worktrees, bring home. |
| `src/server/orchestrator.ts` (modify) | Kits per node; placement; adopt and park per node; removal; remote git actions; bring home. |
| `src/server/node-kits.ts` (new) | `NodeKits` registry and `buildNodeKit`. |
| `src/server/dashboard-api.ts`, `src/server/cli.ts` (modify) | `POST review/bring-home`; wiring. |
| `src/web/nodes.ts`, `src/web/api.ts` (modify) | `nodeChoices`, `envNode`; `bringHome`, `node` in `createTask`. |
| `src/web/components/NewTaskDialog.tsx`, `EnvBadge.tsx`, `Worktrees.tsx` (modify) | Node select, node badge, remove wording. |
| `src/web/pages/CheckoutPage.tsx`, `ProjectReview.tsx`, `NodesPage.tsx` (modify) | Hide the editor menu; Bring home; page text. |
| `../../README.md` (modify) | Remote nodes section. |

---

### Task 1: Node home, connection target, online and offline events

**Files:**
- Modify: `src/server/host.ts`, `src/server/ssh.ts`, `src/server/node-connection.ts`, `src/server/nodes.ts`
- Test: `test/server/host.test.ts`, `test/server/node-connection.test.ts`, `test/server/nodes.test.ts`

**Interfaces:**
- Produces:
  - `Host.home: string`: the absolute home folder on that machine. `localHost().home` is `os.homedir()`. `SshHost.home` starts as `""` and is set by `NodeConnection` before the node goes online.
  - `NodeConnection.target: SshTarget` (public, readonly).
  - `NodeConnectionPort.target?: SshTarget`.
  - `Nodes.connection(id: NodeId): NodeConnectionPort | undefined`.
  - `NodesOptions.onOnline?: (id: NodeId) => void`, `NodesOptions.onOffline?: (id: NodeId) => void`. Each fires once per transition. Removing an online node fires `onOffline`.

- [ ] **Step 1: Write the failing tests**

In `test/server/host.test.ts`, add `import os from "node:os";` if missing, and inside `describe("localHost", …)`:

```ts
  it("knows this machine's home folder", () => {
    expect(localHost().home).toBe(os.homedir());
  });
```

In `test/server/node-connection.test.ts`, change `setup` so the runner answers the home query, and let a test override it:

```ts
function setup(opts: { check?: (n: number) => number; preflight?: () => Promise<string[]>; home?: string } = {}) {
```

and in its `fakeRunner` handler, before `return {};`:

```ts
    if (c.args.at(-1)?.includes('"$HOME"')) return { stdout: opts.home ?? "/home/tim" };
```

Then add inside `describe("NodeConnection", …)`:

```ts
  it("reads the node's home folder before going online", async () => {
    const { conn } = setup();
    conn.start();
    await vi.waitFor(() => expect(conn.online).toBe(true));
    expect(conn.host.home).toBe("/home/tim");
    expect(conn.target).toEqual({ dest: "tim@box", control: expect.stringMatching(/box\.sock$/) });
  });

  it("stays unreachable when $HOME can't be read", async () => {
    const { conn, history } = setup({ home: "" });
    conn.start();
    await vi.waitFor(() =>
      expect(history).toContainEqual(expect.objectContaining({ state: "unreachable", reason: "could not read $HOME on tim@box" })),
    );
  });
```

In `test/server/nodes.test.ts`, add inside `describe("Nodes", …)`:

```ts
  it("reports nodes coming online and going offline, once per change", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-reg-"));
    dirs.push(configDir);
    saveConfig(configDir, { roots: [], port: 7777, nodes: [{ id: "box", ssh: "tim@box" }] });
    const conn = fakeConnection({ id: "box", ssh: "tim@box" }, false);
    let notify = () => {};
    const onOnline = vi.fn();
    const onOffline = vi.fn();
    const registry = new Nodes({
      configDir,
      controlDir: path.join(configDir, "ssh"),
      store: { setNodes: vi.fn() },
      local: localHost(fakeRunner().run),
      connect: (_n, onChange) => {
        notify = onChange;
        return conn;
      },
      stats: async () => undefined,
      statsIntervalMs: 1000,
      onOnline,
      onOffline,
    });
    registry.start();
    expect(registry.connection("box")).toBe(conn);
    expect(onOnline).not.toHaveBeenCalled();
    conn.online = true;
    notify();
    notify();
    expect(onOnline).toHaveBeenCalledTimes(1);
    expect(onOnline).toHaveBeenCalledWith("box");
    conn.online = false;
    notify();
    expect(onOffline).toHaveBeenCalledWith("box");
    conn.online = true;
    notify();
    await registry.remove("box");
    expect(onOffline).toHaveBeenCalledTimes(2);
    expect(registry.connection("box")).toBeUndefined();
    await registry.close();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/host.test.ts test/server/node-connection.test.ts test/server/nodes.test.ts`
Expected: FAIL. `home` is undefined, `conn.target` is private or undefined, and `connection` and the callbacks don't exist.

- [ ] **Step 3: Implement**

`src/server/host.ts`: add `import os from "node:os";`, and to the `Host` interface:

```ts
  /** The absolute home folder on that machine; opendevhub's files on a node go under `<home>/.opendevhub`. */
  home: string;
```

In `localHost`, add `home: os.homedir(),`.

`src/server/ssh.ts`: in `SshHost`, add as the first member:

```ts
  /** Set by the NodeConnection once the node answered; empty until then. */
  home = "";
```

`src/server/node-connection.ts`: change `private readonly target: SshTarget;` to `readonly target: SshTarget;`. In `connect()`, right after `await this.openMaster();`:

```ts
      const home = (await this.host.run("sh", ["-c", 'printf %s "$HOME"'], { timeoutMs: 10_000 })).stdout.trim();
      if (!home.startsWith("/")) throw new Error(`could not read $HOME on ${this.target.dest}`);
      this.host.home = home;
```

`src/server/nodes.ts`:
- Import `type SshTarget` from `./ssh`. Add `readonly target?: SshTarget;` to `NodeConnectionPort`.
- Add to `NodesOptions`:

```ts
  /** A node became online: called once per transition. */
  onOnline?: (id: NodeId) => void;
  /** A node stopped being online, or an online node was removed. */
  onOffline?: (id: NodeId) => void;
```

- Add the field `private readonly wasOnline = new Set<NodeId>();` and the method:

```ts
  /** A configured node's connection, online or not. */
  connection(id: NodeId): NodeConnectionPort | undefined {
    return this.connections.get(id);
  }
```

- Replace `publish()` with:

```ts
  private publish(): void {
    if (this.stopped) return;
    for (const [id, conn] of this.connections) {
      if (conn.online && !this.wasOnline.has(id)) {
        this.wasOnline.add(id);
        this.opts.onOnline?.(id);
      } else if (!conn.online && this.wasOnline.delete(id)) {
        this.opts.onOffline?.(id);
      }
    }
    this.opts.store.setNodes(this.list());
  }
```

- In `remove()`, after `this.stats.delete(id);`, add `if (this.wasOnline.delete(id)) this.opts.onOffline?.(id);`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/host.test.ts test/server/node-connection.test.ts test/server/nodes.test.ts test/server/ssh.test.ts && pnpm typecheck`
Expected: PASS. Fix any other `Host` literal the typecheck names by adding `home`.

- [ ] **Step 5: Commit**

```bash
git add src/server/host.ts src/server/ssh.ts src/server/node-connection.ts src/server/nodes.ts test/server/host.test.ts test/server/node-connection.test.ts test/server/nodes.test.ts
git commit -m "feat(server): node home folders, and events when nodes come and go"
```

---

### Task 2: `node` on environments, worktrees and task requests

**Files:**
- Modify: `src/shared/types.ts`, `src/server/state.ts`, `src/server/config.ts`, `src/server/tasks.ts`
- Test: `test/server/state.test.ts`, `test/server/tasks.test.ts`

**Interfaces:**
- Produces:
  - `EnvironmentView.node?: NodeId`: set only for environments on another node.
  - `Worktree.node?: NodeId`: set only on remote worktrees in the snapshot, which have no `hostPath`.
  - `TaskRequest.node?: NodeId`: absent for `local`.
  - `EnvRecord.node?: NodeId` and `PersistedEnv.node?: NodeId`: absent for `local`.
  - `StateStore.snapshot()`: each project's `runtime.worktrees` ends with `{ path, branch, node }` for each remote environment, and `environments[i].node` is set for them.

- [ ] **Step 1: Write the failing tests**

Add to `test/server/state.test.ts`, inside its top-level `describe`:

```ts
  it("keeps an environment's node across restarts and lists its worktree as remote", () => {
    const project = { id: "demo-abc123", name: "demo", path: "/src/demo", devcontainerPath: "/src/demo/.devcontainer/devcontainer.json" };
    const saved: PersistedState[] = [];
    const store = new StateStore({ port: 7777, persisted: { projects: {} }, persist: (s) => saved.push(structuredClone(s)) });
    store.setProjects([project]);
    store.updateRuntime(project.id, { worktrees: [{ path: "/workspaces/demo.worktrees/a", hostPath: "/src/demo.worktrees/a", branch: "a" }] });
    const worktree = { path: "/workspaces/demo.worktrees/fix", hostPath: "/home/tim/.opendevhub/repos/demo-abc123/demo.worktrees/fix", branch: "fix" };
    store.putEnvironment({ id: "demo-abc123-fix-1a2b", projectId: project.id, worktree, node: "box" });
    store.updateRuntime("demo-abc123-fix-1a2b", { containerId: "r1" });
    expect(saved.at(-1)?.environments?.["demo-abc123-fix-1a2b"]).toMatchObject({ node: "box", worktree });

    const view = store.snapshot().projects[0];
    expect(view.environments[0].node).toBe("box");
    expect(view.runtime.worktrees).toEqual([
      { path: "/workspaces/demo.worktrees/a", hostPath: "/src/demo.worktrees/a", branch: "a" },
      { path: "/workspaces/demo.worktrees/fix", branch: "fix", node: "box" },
    ]);

    const again = new StateStore({ port: 7777, persisted: saved.at(-1)!, persist: () => {} });
    expect(again.environment("demo-abc123-fix-1a2b")?.node).toBe("box");
  });
```

Import `PersistedState` if the file doesn't yet (it does: `import type { PersistedState } from "../../src/server/config";`).

Add to `test/server/tasks.test.ts`, in the `parseTaskRequest` describe:

```ts
  it("reads the node, leaving it out for this machine", () => {
    expect(parseTaskRequest({ prompt: "x", environment: "isolated", node: "box" }).node).toBe("box");
    expect(parseTaskRequest({ prompt: "x", node: "local" }).node).toBeUndefined();
    expect(parseTaskRequest({ prompt: "x" }).node).toBeUndefined();
    expect(() => parseTaskRequest({ prompt: "x", node: "Bad Node" })).toThrow(/invalid node/);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/state.test.ts test/server/tasks.test.ts`
Expected: FAIL. `node` is dropped, and no remote worktree is listed.

- [ ] **Step 3: Implement**

`src/shared/types.ts`:
- In `Worktree`, after `hostPath?`:

```ts
  /** Set on worktrees that live on another node; they have no hostPath on this machine. */
  node?: NodeId;
```

- In `EnvironmentView`, after `worktree`:

```ts
  /** The node it runs on; absent for this machine. */
  node?: NodeId;
```

- In `TaskRequest`, after `environment?`:

```ts
  /** The node isolated variants run on; absent for this machine. */
  node?: NodeId;
```

`src/server/config.ts`: in `PersistedEnv`, add `node?: NodeId;` (import `NodeId` in the type import if it isn't there yet).

`src/server/state.ts`:
- `EnvRecord`: add `/** Absent for this machine. */ node?: NodeId;` (add `NodeId` to the type import).
- In the constructor's environment loop:

```ts
      const { projectId, worktree, image, node, ...runtime } = saved;
      this.envs.set(id, { id, projectId, worktree, ...(image ? { image } : {}), ...(node ? { node } : {}) });
```

- In `save()`, the environment entry becomes:

```ts
      environments[id] = {
        projectId: e.projectId,
        worktree: e.worktree,
        ...(e.image ? { image: e.image } : {}),
        ...(e.node ? { node: e.node } : {}),
        ...durable(this.runtime(id)),
      };
```

- In `snapshot()`, inside `projects: this.projects().map((project) => {`, before `return {`, compute:

```ts
        const envs = this.environments(project.id);
        const remote: Worktree[] = envs.flatMap((e) => (e.node ? [{ path: e.worktree.path, branch: e.worktree.branch, node: e.node }] : []));
        const runtime = publicRuntime(this.runtime(project.id));
```

  Then replace `runtime: publicRuntime(this.runtime(project.id)),` with:

```ts
          runtime: remote.length > 0 ? { ...runtime, worktrees: [...(runtime.worktrees ?? []), ...remote] } : runtime,
```

  Replace `environments: this.environments(project.id).map((e) => ({` with `environments: envs.map((e) => ({`, and add `...(e.node ? { node: e.node } : {}),` after `worktree: e.worktree,`. Add `Worktree` to the type import.

`src/server/tasks.ts`: in `parseTaskRequest`, after the `environment` check:

```ts
  const rawNode = str(body.node)?.trim() || undefined;
  if (rawNode !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(rawNode)) {
    throw new InvalidRequestError(`invalid node "${rawNode}"`);
  }
  const node = rawNode === "local" ? undefined : rawNode;
```

and add `...(node ? { node } : {}),` to the returned object after the `environment` spread.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/state.test.ts test/server/tasks.test.ts test/web && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/types.ts src/server/state.ts src/server/config.ts src/server/tasks.ts test/server/state.test.ts test/server/tasks.test.ts
git commit -m "feat: environments, worktrees and task requests carry their node"
```

---

### Task 3: Building blocks that work on any host

**Files:**
- Modify: `src/server/containers.ts`, `src/server/git.ts`, `src/server/images.ts`, `src/server/env-files.ts`, `src/server/cli.ts`
- Test: `test/server/containers.test.ts`, `test/server/git.test.ts`, `test/server/images.test.ts`, `test/server/env-files.test.ts`

**Interfaces:**
- Consumes: `Host` (Plan 1, with `home` from Task 1); `Runner`.
- Produces:
  - `Containers.inspect` throws a `CommandError` when the runner exits 255 (ssh couldn't reach the node). Other failures still return `undefined`.
  - `GitOps` methods take `ExecTarget` where they took `Project`. `Project` still fits.
  - `export function hostHeadObjects(run: Runner, dir: string, paths: string[]): Promise<(string | undefined)[]>` in `git.ts`: git on the machine `run` reaches, not in a container.
  - `ImagesDeps.objects: (project: Project, worktree: EnvWorktree, paths: string[]) => Promise<(string | undefined)[]>` replaces `ImagesDeps.git`.
  - `new EnvFiles(dir, host?)`: with a host, `write` uses `host.writeFile` and `remove` runs `rm -rf -- <folder>` through `host.run`.

- [ ] **Step 1: Write the failing tests**

`test/server/containers.test.ts`, add (import `fakeRunner` from `../helpers/fake-runner` if missing):

```ts
describe("Containers.inspect over ssh", () => {
  it("throws when ssh fails, instead of reporting the container gone", async () => {
    const down = new Containers(fakeRunner(() => ({ exitCode: 255, stderr: "ssh: connect to host box port 22: Connection refused\n" })).run);
    await expect(down.inspect("c1")).rejects.toThrow(/docker inspect could not run.*Connection refused/);
    const gone = new Containers(fakeRunner(() => ({ exitCode: 1, stderr: "Error: No such container: c1\n" })).run);
    expect(await gone.inspect("c1")).toBeUndefined();
  });
});
```

`test/server/git.test.ts`, add (import `hostHeadObjects` from `../../src/server/git` and `fakeRunner`):

```ts
describe("hostHeadObjects", () => {
  it("runs git on the host in the folder, one object per path", async () => {
    const fake = fakeRunner(() => ({ stdout: "abc123\n-\n" }));
    expect(await hostHeadObjects(fake.run, "/home/tim/w/fix", [".devcontainer", "package-lock.json"])).toEqual(["abc123", undefined]);
    expect(fake.calls[0].cmd).toBe("sh");
    expect(fake.calls[0].args.slice(2)).toEqual(["sh", "/home/tim/w/fix", ".devcontainer", "package-lock.json"]);
  });

  it("throws when git fails", async () => {
    await expect(hostHeadObjects(fakeRunner(() => ({ exitCode: 128, stderr: "fatal: not a git repository\n" })).run, "/x", ["a"])).rejects.toThrow(
      /git rev-parse failed/,
    );
  });
});
```

`test/server/images.test.ts`: in `setup`, replace the `git` fake with:

```ts
  const objects = vi.fn(async (_p: Project, _w: EnvWorktree, _paths: string[]) => list);
```

rename the `setup` parameter from `objects` to `list`, construct `new Images({ run, containers, objects })`, and return `objects` instead of `git`. In the tests, `git.headObjects` becomes `objects`. The assertion on line 63 becomes:

```ts
    expect(objects).toHaveBeenCalledWith(project, wt("a"), [".devcontainer", ".devcontainer.json", "package-lock.json"]);
```

The mock on line 87 becomes `objects.mockImplementation(async (_p: Project, w: EnvWorktree) => [w.path]);`. Destructure `objects` where those tests destructured `git`.

`test/server/env-files.test.ts`, add (import `fakeRunner` and `localHost`):

```ts
  it("writes and removes through a host", async () => {
    const written: Array<[string, string]> = [];
    const fake = fakeRunner();
    const host = { ...localHost(fake.run), writeFile: async (f: string, c: string) => void written.push([f, c]) };
    const files = new EnvFiles("/home/tim/.opendevhub/envs", host);
    expect(await files.write("demo-feat-0a1b", { image: "x" })).toBe("/home/tim/.opendevhub/envs/demo-feat-0a1b/devcontainer.json");
    expect(written).toEqual([["/home/tim/.opendevhub/envs/demo-feat-0a1b/devcontainer.json", '{\n  "image": "x"\n}\n']]);
    await files.remove("demo-feat-0a1b");
    expect(fake.calls).toEqual([{ cmd: "rm", args: ["-rf", "--", "/home/tim/.opendevhub/envs/demo-feat-0a1b"], opts: { timeoutMs: 30_000 } }]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/containers.test.ts test/server/git.test.ts test/server/images.test.ts test/server/env-files.test.ts`
Expected: FAIL. `inspect` returns undefined on 255, `hostHeadObjects` and `objects` don't exist, and `EnvFiles` ignores a host.

- [ ] **Step 3: Implement**

`src/server/containers.ts`, in `inspect`, before `if (r.exitCode !== 0) return undefined;`:

```ts
    // ssh exits 255 when it can't reach the node; docker itself never does. Unknown, not gone.
    if (r.exitCode === 255) throw new CommandError(`docker inspect could not run: ${r.stderr.trim() || "ssh exited 255"}`, tailLines(r.stderr));
```

`src/server/git.ts`:
- Import `type ExecTarget` from `./containers` and `type Runner` from `./exec` (the latter next to `RunResult`).
- Replace `p: Project` with `p: ExecTarget` in every `GitOps` method signature (and in the private `exec`, `git` and `conflicts`). Drop `Project` from the type import if nothing else uses it.
- Move the `headObjects` script into module scope and add the host variant:

```ts
const HEAD_OBJECTS = 'd="$1"; shift; for p in "$@"; do git -C "$d" rev-parse --verify --quiet "HEAD:$p" || echo -; done';

function parseHeadObjects(stdout: string, paths: string[]): (string | undefined)[] {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  return paths.map((_, i) => (lines[i] && lines[i] !== "-" ? lines[i] : undefined));
}

/** Like GitOps.headObjects, but with the git of the machine `run` reaches (a node), not a container's. */
export async function hostHeadObjects(run: Runner, dir: string, paths: string[]): Promise<(string | undefined)[]> {
  const r = await run("sh", ["-c", HEAD_OBJECTS, "sh", dir, ...paths], { timeoutMs: GIT_TIMEOUT_MS });
  if (r.exitCode !== 0) throw failure(["rev-parse"], r);
  return parseHeadObjects(r.stdout, paths);
}
```

and make `GitOps.headObjects` use `HEAD_OBJECTS` and `parseHeadObjects`.

`src/server/images.ts`:
- Replace `git: Pick<GitOps, "headObjects">;` in `ImagesDeps` with:

```ts
  /** The object id at HEAD of each path in the worktree (undefined where missing). */
  objects: (project: Project, worktree: EnvWorktree, paths: string[]) => Promise<(string | undefined)[]>;
```

- In `ensureBase`, use `this.deps.objects(project, worktree, [...KEY_PATHS, ...keyFiles])`. Remove the `GitOps` import.

`src/server/cli.ts`: construct Images with `objects: (p, wt, paths) => git.headObjects(p, wt.path, paths)` in place of `git`.

`src/server/env-files.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import type { EnvId } from "../shared/types";
import type { Host } from "./host";

const ENV_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** The generated devcontainer.json of each task environment, one folder per environment, here or on a node. */
export class EnvFiles {
  constructor(
    private readonly dir: string,
    private readonly host?: Pick<Host, "run" | "writeFile">,
  ) {}

  path(envId: EnvId): string {
    return path.posix.join(this.folder(envId), "devcontainer.json");
  }

  async write(envId: EnvId, config: Record<string, unknown>): Promise<string> {
    const file = this.path(envId);
    const content = JSON.stringify(config, null, 2) + "\n";
    if (this.host) {
      await this.host.writeFile(file, content);
      return file;
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  }

  async remove(envId: EnvId): Promise<void> {
    const folder = this.folder(envId);
    if (!this.host) {
      await fs.rm(folder, { recursive: true, force: true });
      return;
    }
    const r = await this.host.run("rm", ["-rf", "--", folder], { timeoutMs: 30_000 });
    if (r.exitCode !== 0) throw new Error(`removing ${folder} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }

  private folder(envId: EnvId): string {
    if (!ENV_ID.test(envId)) throw new Error(`invalid environment id ${envId}`);
    return path.posix.join(this.dir, envId);
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/containers.test.ts test/server/git.test.ts test/server/images.test.ts test/server/env-files.test.ts test/server/orchestrator.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/containers.ts src/server/git.ts src/server/images.ts src/server/env-files.ts src/server/cli.ts test/server/containers.test.ts test/server/git.test.ts test/server/images.test.ts test/server/env-files.test.ts
git commit -m "refactor(server): containers, git, images and env files work on any host"
```

---

### Task 4: `NodeRepo`, the project's repository on a node

**Files:**
- Create: `src/server/node-repo.ts`
- Test: `test/server/node-repo.test.ts`

**Interfaces:**
- Consumes: `Host` (with `home`), `SshTarget` and `shellQuote` (Plan 1); `Runner`; `CommandError`, `tailLines`; `InvalidRequestError`, `worktreeDirName`.
- Produces:

```ts
export interface NodeRepoLayout {
  /** The repository on the node, never checked out. */
  repo: string;
  gitDir: string;
  /** Where its worktrees go on the node. */
  worktrees: string;
  /** `ssh://<dest><repo>`, for the hub's git. */
  url: string;
  /** The project's workspace folder in containers; remote worktrees sit at `<workspaceFolder>.worktrees/<dir>`. */
  workspaceFolder: string;
}
export interface NodeRepoPort {
  layout(project: Project, workspaceFolder: string): NodeRepoLayout;
  ensure(layout: NodeRepoLayout): Promise<void>;
  branches(layout: NodeRepoLayout): Promise<string[]>;
  pushBase(project: Project, layout: NodeRepoLayout, base: string): Promise<void>;
  addWorktree(layout: NodeRepoLayout, branch: string, base: string): Promise<EnvWorktree>;
  removeWorktree(layout: NodeRepoLayout, worktree: EnvWorktree): Promise<void>;
  bringHome(project: Project, layout: NodeRepoLayout, branch: string): Promise<void>;
}
export class NodeRepo implements NodeRepoPort {
  constructor(deps: { node: NodeId; host: Pick<Host, "run" | "home">; target: SshTarget; local: Runner });
}
```

- [ ] **Step 1: Write the failing tests**

Create `test/server/node-repo.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { NodeRepo } from "../../src/server/node-repo";
import type { Project } from "../../src/shared/types";
import { type Call, fakeRunner } from "../helpers/fake-runner";

const project: Project = { id: "demo-abc123", name: "demo", path: "/src/demo", devcontainerPath: "/src/demo/.devcontainer/devcontainer.json" };
const target = { dest: "tim@box", control: "/home/me/.config/opendevhub/ssh dir/box.sock" };
const SSH = { GIT_SSH_COMMAND: "ssh -S '/home/me/.config/opendevhub/ssh dir/box.sock' -o BatchMode=yes", GIT_TERMINAL_PROMPT: "0" };

function setup(remote: (c: Call) => object = () => ({}), local: (c: Call) => object = () => ({})) {
  const node = fakeRunner(remote);
  const hub = fakeRunner(local);
  const repo = new NodeRepo({ node: "box", host: { run: node.run, home: "/home/tim" }, target, local: hub.run });
  return { repo, node, hub, layout: repo.layout(project, "/workspaces/demo") };
}

describe("NodeRepo", () => {
  it("lays the repository out so relative worktree links match the containers", () => {
    expect(setup().layout).toEqual({
      repo: "/home/tim/.opendevhub/repos/demo-abc123/demo",
      gitDir: "/home/tim/.opendevhub/repos/demo-abc123/demo/.git",
      worktrees: "/home/tim/.opendevhub/repos/demo-abc123/demo.worktrees",
      url: "ssh://tim@box/home/tim/.opendevhub/repos/demo-abc123/demo",
      workspaceFolder: "/workspaces/demo",
    });
  });

  it("creates the repository once, never checked out", async () => {
    const { repo, node, layout } = setup();
    await repo.ensure(layout);
    expect(node.calls[0].cmd).toBe("sh");
    expect(node.calls[0].args[1]).toContain("git init -q");
    expect(node.calls[0].args[1]).toContain("receive.denyCurrentBranch ignore");
    expect(node.calls[0].args.slice(2)).toEqual(["sh", layout.repo]);
    const broken = setup(() => ({ exitCode: 1, stderr: "mkdir: Permission denied\n" }));
    await expect(broken.repo.ensure(broken.layout)).rejects.toThrow(/preparing .* on box failed: mkdir: Permission denied/);
  });

  it("lists branches, and none before the repository exists", async () => {
    const { repo, layout } = setup(() => ({ stdout: "fix\nmain\n" }));
    expect(await repo.branches(layout)).toEqual(["fix", "main"]);
    const empty = setup(() => ({ exitCode: 128, stderr: "fatal: cannot change to '/home/tim/…': No such file or directory\n" }));
    expect(await empty.repo.branches(empty.layout)).toEqual([]);
  });

  it("pushes the base from this machine through the master, slashes and all", async () => {
    const { repo, hub, layout } = setup();
    await repo.pushBase(project, layout, "origin/main");
    expect(hub.calls[0]).toEqual({
      cmd: "git",
      args: ["-C", "/src/demo", "push", "--no-verify", "--quiet", layout.url, "+origin/main:refs/heads/origin/main"],
      opts: { env: SSH, timeoutMs: 120_000, detached: true },
    });
    const failing = setup(undefined, () => ({ exitCode: 128, stderr: "fatal: Could not read from remote repository.\n" }));
    await expect(failing.repo.pushBase(project, failing.layout, "main")).rejects.toThrow(/pushing main to box failed: fatal: Could not read/);
  });

  it("adds a worktree with relative links and records its base", async () => {
    const { repo, node, layout } = setup();
    expect(await repo.addWorktree(layout, "feature/x", "main")).toEqual({
      path: "/workspaces/demo.worktrees/feature-x",
      hostPath: "/home/tim/.opendevhub/repos/demo-abc123/demo.worktrees/feature-x",
      branch: "feature/x",
    });
    expect(node.calls.map((c) => c.args)).toEqual([
      ["-C", layout.repo, "worktree", "add", "--relative-paths", "-b", "feature/x", "--", `${layout.worktrees}/feature-x`, "main"],
      ["-C", layout.repo, "config", "branch.feature/x.opendevhubBase", "main"],
    ]);
  });

  it("removes a worktree and its branch, pruning one that is already gone", async () => {
    const { repo, node, layout } = setup((c) =>
      c.args.includes("remove") ? { exitCode: 128, stderr: "fatal: '/x' is not a working tree\n" } : {},
    );
    const wt = { path: "/workspaces/demo.worktrees/fix", hostPath: `${layout.worktrees}/fix`, branch: "fix" };
    await repo.removeWorktree(layout, wt);
    expect(node.calls.map((c) => c.args.slice(2))).toEqual([
      ["worktree", "remove", "--force", "--", wt.hostPath],
      ["worktree", "prune"],
      ["branch", "-D", "fix"],
    ]);
  });

  describe("bringHome", () => {
    const incoming = "refs/odh/incoming/fix";
    const script = (answers: Record<string, object>) => (c: Call) => answers[c.args[2]] ?? {};

    it("fetches into a temporary ref and moves a fresh branch onto it", async () => {
      const { repo, hub, layout } = setup(undefined, script({ "rev-parse": { exitCode: 1 } }));
      await repo.bringHome(project, layout, "fix");
      expect(hub.calls.map((c) => c.args.slice(2))).toEqual([
        ["fetch", "--no-tags", "--quiet", layout.url, `+refs/heads/fix:${incoming}`],
        ["rev-parse", "--verify", "-q", "refs/heads/fix"],
        ["update-ref", "refs/heads/fix", incoming],
        ["update-ref", "-d", incoming],
      ]);
      expect(hub.calls[0].opts?.env).toEqual(SSH);
    });

    it("fast-forwards a local branch that is behind", async () => {
      const { repo, hub, layout } = setup(undefined, script({ "symbolic-ref": { stdout: "main\n" } }));
      await repo.bringHome(project, layout, "fix");
      expect(hub.calls.map((c) => c.args[2])).toEqual(["fetch", "rev-parse", "symbolic-ref", "merge-base", "update-ref", "update-ref"]);
    });

    it("refuses a diverged or checked-out local branch and leaves it alone", async () => {
      const diverged = setup(undefined, script({ "symbolic-ref": { stdout: "main\n" }, "merge-base": { exitCode: 1 } }));
      await expect(diverged.repo.bringHome(project, diverged.layout, "fix")).rejects.toThrow("local branch fix has diverged from the one on box");
      expect(diverged.hub.calls.filter((c) => c.args[2] === "update-ref").map((c) => c.args.slice(3))).toEqual([["-d", incoming]]);

      const current = setup(undefined, script({ "symbolic-ref": { stdout: "fix\n" } }));
      await expect(current.repo.bringHome(project, current.layout, "fix")).rejects.toThrow(/fix is checked out in the main checkout/);
    });

    it("reports a fetch that fails", async () => {
      const { repo, layout } = setup(undefined, script({ fetch: { exitCode: 128, stderr: "fatal: couldn't find remote ref refs/heads/fix\n" } }));
      await expect(repo.bringHome(project, layout, "fix")).rejects.toThrow(/fetching fix from box failed: fatal: couldn't find remote ref/);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/node-repo.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/server/node-repo.ts`:

```ts
import path from "node:path";
import type { EnvWorktree, NodeId, Project } from "../shared/types";
import { CommandError, tailLines } from "./containers";
import type { RunResult, Runner } from "./exec";
import type { Host } from "./host";
import { type SshTarget, shellQuote } from "./ssh";
import { InvalidRequestError, worktreeDirName } from "./worktrees";

const GIT_TIMEOUT_MS = 120_000;

const ENSURE =
  'set -e; mkdir -p "$1"; cd "$1"; if [ ! -d .git ]; then git init -q; git config receive.denyCurrentBranch ignore; fi';

export interface NodeRepoLayout {
  /** The repository on the node, never checked out. */
  repo: string;
  gitDir: string;
  /** Where its worktrees go on the node. */
  worktrees: string;
  /** `ssh://<dest><repo>`, for the hub's git. */
  url: string;
  /** The project's workspace folder in containers; remote worktrees sit at `<workspaceFolder>.worktrees/<dir>`. */
  workspaceFolder: string;
}

export interface NodeRepoPort {
  layout(project: Project, workspaceFolder: string): NodeRepoLayout;
  ensure(layout: NodeRepoLayout): Promise<void>;
  branches(layout: NodeRepoLayout): Promise<string[]>;
  pushBase(project: Project, layout: NodeRepoLayout, base: string): Promise<void>;
  addWorktree(layout: NodeRepoLayout, branch: string, base: string): Promise<EnvWorktree>;
  removeWorktree(layout: NodeRepoLayout, worktree: EnvWorktree): Promise<void>;
  bringHome(project: Project, layout: NodeRepoLayout, branch: string): Promise<void>;
}

function lastLine(r: RunResult): string {
  return tailLines(`${r.stderr}\n${r.stdout}`, 1)[0] ?? `exit ${r.exitCode}`;
}

/**
 * The project's repository on a node: created on first use, fed by pushes from this machine, with task
 * worktrees next to it. The hub's git reaches it through the node's ControlMaster.
 */
export class NodeRepo implements NodeRepoPort {
  constructor(private readonly deps: { node: NodeId; host: Pick<Host, "run" | "home">; target: SshTarget; local: Runner }) {}

  /** Named after the workspace folder, so links git writes relative to the node's layout resolve in containers too. */
  layout(project: Project, workspaceFolder: string): NodeRepoLayout {
    const name = path.posix.basename(workspaceFolder);
    const parent = path.posix.join(this.deps.host.home, ".opendevhub", "repos", project.id);
    const repo = path.posix.join(parent, name);
    return {
      repo,
      gitDir: path.posix.join(repo, ".git"),
      worktrees: path.posix.join(parent, `${name}.worktrees`),
      url: `ssh://${this.deps.target.dest}${repo}`,
      workspaceFolder,
    };
  }

  async ensure(layout: NodeRepoLayout): Promise<void> {
    const r = await this.deps.host.run("sh", ["-c", ENSURE, "sh", layout.repo], { timeoutMs: GIT_TIMEOUT_MS });
    if (r.exitCode !== 0) throw new CommandError(`preparing ${layout.repo} on ${this.deps.node} failed: ${lastLine(r)}`, tailLines(r.stderr));
  }

  async branches(layout: NodeRepoLayout): Promise<string[]> {
    const r = await this.git(layout, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    if (r.exitCode !== 0) return [];
    return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  }

  async pushBase(project: Project, layout: NodeRepoLayout, base: string): Promise<void> {
    const r = await this.hub(project, ["push", "--no-verify", "--quiet", layout.url, `+${base}:refs/heads/${base}`]);
    if (r.exitCode !== 0) throw new CommandError(`pushing ${base} to ${this.deps.node} failed: ${lastLine(r)}`, tailLines(r.stderr));
  }

  async addWorktree(layout: NodeRepoLayout, branch: string, base: string): Promise<EnvWorktree> {
    const dir = worktreeDirName(branch);
    const hostPath = path.posix.join(layout.worktrees, dir);
    await this.must(layout, ["worktree", "add", "--relative-paths", "-b", branch, "--", hostPath, base], `creating worktree ${branch}`);
    await this.must(layout, ["config", `branch.${branch}.opendevhubBase`, base], `recording the base of ${branch}`);
    return { path: path.posix.join(`${layout.workspaceFolder}.worktrees`, dir), hostPath, branch };
  }

  async removeWorktree(layout: NodeRepoLayout, worktree: EnvWorktree): Promise<void> {
    const r = await this.git(layout, ["worktree", "remove", "--force", "--", worktree.hostPath]);
    if (r.exitCode !== 0) {
      if (!/is not a working tree/.test(r.stderr)) {
        throw new CommandError(`removing worktree ${worktree.branch} on ${this.deps.node} failed: ${lastLine(r)}`, tailLines(r.stderr));
      }
      await this.git(layout, ["worktree", "prune"]);
    }
    await this.must(layout, ["branch", "-D", worktree.branch], `deleting branch ${worktree.branch}`);
  }

  /**
   * Fetches the node's branch into this machine's repository: a new branch, or a fast-forward of the local one.
   * Never moves a local branch that diverged or that the main checkout has checked out.
   */
  async bringHome(project: Project, layout: NodeRepoLayout, branch: string): Promise<void> {
    const incoming = `refs/odh/incoming/${branch}`;
    const local = `refs/heads/${branch}`;
    const fetched = await this.hub(project, ["fetch", "--no-tags", "--quiet", layout.url, `+${local}:${incoming}`]);
    if (fetched.exitCode !== 0) {
      throw new CommandError(`fetching ${branch} from ${this.deps.node} failed: ${lastLine(fetched)}`, tailLines(fetched.stderr));
    }
    try {
      const exists = (await this.hub(project, ["rev-parse", "--verify", "-q", local])).exitCode === 0;
      if (exists) {
        const head = await this.hub(project, ["symbolic-ref", "--short", "-q", "HEAD"]);
        if (head.stdout.trim() === branch) {
          throw new InvalidRequestError(`${branch} is checked out in the main checkout; switch it to another branch first`);
        }
        const ancestor = await this.hub(project, ["merge-base", "--is-ancestor", local, incoming]);
        if (ancestor.exitCode === 1) throw new InvalidRequestError(`local branch ${branch} has diverged from the one on ${this.deps.node}`);
        if (ancestor.exitCode !== 0) throw new CommandError(`comparing ${branch} failed: ${lastLine(ancestor)}`, tailLines(ancestor.stderr));
      }
      const moved = await this.hub(project, ["update-ref", local, incoming]);
      if (moved.exitCode !== 0) throw new CommandError(`updating ${branch} failed: ${lastLine(moved)}`, tailLines(moved.stderr));
    } finally {
      await this.hub(project, ["update-ref", "-d", incoming]);
    }
  }

  private git(layout: NodeRepoLayout, args: string[]): Promise<RunResult> {
    return this.deps.host.run("git", ["-C", layout.repo, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  }

  private async must(layout: NodeRepoLayout, args: string[], what: string): Promise<void> {
    const r = await this.git(layout, args);
    if (r.exitCode !== 0) throw new CommandError(`${what} on ${this.deps.node} failed: ${lastLine(r)}`, tailLines(r.stderr));
  }

  /** git in the project's folder on this machine, reaching the node through its ControlMaster. */
  private hub(project: Project, args: string[]): Promise<RunResult> {
    return this.deps.local("git", ["-C", project.path, ...args], {
      env: {
        GIT_SSH_COMMAND: `ssh -S ${shellQuote(this.deps.target.control)} -o BatchMode=yes`,
        GIT_TERMINAL_PROMPT: "0",
      },
      timeoutMs: GIT_TIMEOUT_MS,
      detached: true,
    });
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/node-repo.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/node-repo.ts test/server/node-repo.test.ts
git commit -m "feat(server): NodeRepo keeps a project's repository and worktrees on a node"
```

---

### Task 5: The orchestrator resolves each environment's node kit

**Files:**
- Modify: `src/server/orchestrator.ts`
- Test: `test/server/orchestrator.test.ts`

**Interfaces:**
- Consumes: `NodeRepoPort`, `NodeRepoLayout` (Task 4); `EnvRecord.node` (Task 2); `LOCAL_NODE` (Plan 1).
- Produces (in `orchestrator.ts`):

```ts
export interface NodeKit {
  containers: ContainersPort;
  runtime: RuntimePort;
  relay: RelayPort;
  images: ImagesPort;
  envFiles: EnvFilesPort;
  credentials?: CredentialsPort;
  network: NetworkPort;
  git: GitPort;
  repo: NodeRepoPort;
}
export interface NodeKitsPort {
  known(node: NodeId): boolean;
  kit(node: NodeId): NodeKit | undefined;
}
// OrchestratorDeps gains: nodes?: NodeKitsPort;
```

- [ ] **Step 1: Add the test fakes**

In `test/server/orchestrator.test.ts`, import `type NodeKit, type NodeKitsPort` from the orchestrator and `type NodeRepoLayout` from `../../src/server/node-repo`. Add `envLabels` to the containers import. After the `runningTask` constant, add:

```ts
const remoteFix = {
  path: "/workspaces/demo.worktrees/fix",
  hostPath: "/home/tim/.opendevhub/repos/demo-abc123/demo.worktrees/fix",
  branch: "fix",
};
const remoteEnv = envIdFor(project.id, `box:${remoteFix.path}`, "fix");

/** Fakes for node "box", shaped like setup()'s; `online.box` turns it off. */
function boxKit() {
  const layout = (p: Project, ws: string): NodeRepoLayout => ({
    repo: `/home/tim/.opendevhub/repos/${p.id}/demo`,
    gitDir: `/home/tim/.opendevhub/repos/${p.id}/demo/.git`,
    worktrees: `/home/tim/.opendevhub/repos/${p.id}/demo.worktrees`,
    url: `ssh://tim@box/home/tim/.opendevhub/repos/${p.id}/demo`,
    workspaceFolder: ws,
  });
  const routes: Array<Route & { close: ReturnType<typeof vi.fn> }> = [];
  const info: ContainerInfo = {
    id: "r1",
    name: "demo_fix",
    running: true,
    ip: "172.18.0.4",
    envId: remoteEnv,
    envProjectId: project.id,
    image: "vsc-fix-1234-uid",
    binds: {},
  };
  const kit = {
    containers: {
      workspaceFolder: vi.fn(async (_t?: ExecTarget): Promise<string | undefined> => undefined),
      listManaged: vi.fn(async (): Promise<ContainerInfo[]> => []),
      up: vi.fn(async (_t: ExecTarget, _o: { rebuild: boolean; onLine: (l: string) => void }) => ({
        containerId: "r1",
        remoteWorkspaceFolder: remoteFix.path,
        remoteUser: "node",
      })),
      inspect: vi.fn(async (_id?: string): Promise<ContainerInfo | undefined> => info),
      stop: vi.fn(async (_id: string) => {}),
      readConfiguration: vi.fn(async (_t?: ExecTarget) => ({ forwardPorts: [] as unknown[], portsAttributes: {} as Record<string, unknown> })),
      readConfig: vi.fn(async (_f: string) => ({
        configuration: { image: "node:22" } as Record<string, unknown>,
        workspaceFolder: "/workspaces/fix" as string | undefined,
      })),
      remove: vi.fn(async (_id: string) => {}),
      removeImage: vi.fn(async (_ref: string) => true),
    },
    runtime: {
      endpoint: (a: HostPort, password: string) => ({ baseUrl: `http://${a.host}:${a.port}`, password }),
      ensureRunning: vi.fn(async (_t: ExecTarget, _a: { password?: string }) => ({ password: "pw-box", version: "2.0.20" })),
      stopServer: vi.fn(async () => {}),
      isHealthy: vi.fn(async () => true),
      resolveBinary: vi.fn(async (_t?: ExecTarget): Promise<string | undefined> => "/usr/local/bin/opencode"),
    },
    relay: {
      ensureRunning: vi.fn(async (_t: ExecTarget, _a: { address: HostPort; token: string }): Promise<RelayStatus> => ({ status: "active", via: "bun" })),
      stop: vi.fn(async (_t?: ExecTarget) => {}),
    },
    images: {
      ensureBase: vi.fn(async (p: Project, _w: EnvWorktree, _k: string[], _l: (l: string) => void) => ({
        key: "b".repeat(64),
        ref: `opendevhub/${p.id}:bbbbbbbbbbbb-base`,
      })),
    },
    envFiles: {
      path: (id: string) => `/home/tim/.opendevhub/envs/${id}/devcontainer.json`,
      write: vi.fn(async (id: string, _c: Record<string, unknown>) => `/home/tim/.opendevhub/envs/${id}/devcontainer.json`),
      remove: vi.fn(async (_id: string) => {}),
    },
    credentials: { prepare: vi.fn(async (_t: ExecTarget, _path: string, _o: { sshAgent: boolean; onLine: (l: string) => void }) => {}) },
    network: {
      route: vi.fn(async (_c: RouteContainer, _onLog: (l: string) => void): Promise<Route> => {
        const r = {
          kind: "ssh" as const,
          opencode: { host: "127.0.0.1", port: 41001 },
          relay: { host: "127.0.0.1", port: 41002 },
          dial: vi.fn() as unknown as Dial,
          close: vi.fn(async () => {}),
        };
        routes.push(r);
        return r;
      }),
    },
    git: {
      currentBranch: vi.fn(async (_t: ExecTarget, _dir: string): Promise<string | undefined> => "fix"),
      recordedBase: vi.fn(async (_t: ExecTarget, _dir: string, _b: string): Promise<string | undefined> => "main"),
      aheadBehind: vi.fn(async (_t: ExecTarget, _dir: string, _base: string) => ({ ahead: 3, behind: 0 })),
      isClean: vi.fn(async (_t: ExecTarget, _dir: string) => true),
      isPushed: vi.fn(async (_t: ExecTarget, _dir: string, _b: string) => false),
      commit: vi.fn(async (_t: ExecTarget, _dir: string, _m: string) => {}),
      update: vi.fn(async (_t: ExecTarget, _dir: string, _base: string, strategy: "rebase" | "merge"): Promise<UpdateResult> => ({ strategy })),
    },
    repo: {
      layout: vi.fn(layout),
      ensure: vi.fn(async (_l: NodeRepoLayout) => {}),
      branches: vi.fn(async (_l: NodeRepoLayout): Promise<string[]> => []),
      pushBase: vi.fn(async (_p: Project, _l: NodeRepoLayout, _base: string) => {}),
      addWorktree: vi.fn(async (l: NodeRepoLayout, branch: string, _base: string): Promise<EnvWorktree> => ({
        path: `${l.workspaceFolder}.worktrees/${branch.replace(/\//g, "-")}`,
        hostPath: `${l.worktrees}/${branch.replace(/\//g, "-")}`,
        branch,
      })),
      removeWorktree: vi.fn(async (_l: NodeRepoLayout, _w: EnvWorktree) => {}),
      bringHome: vi.fn(async (_p: Project, _l: NodeRepoLayout, _b: string) => {}),
    },
  };
  const online = { box: true };
  const nodes: NodeKitsPort = {
    known: (n) => n === "box",
    kit: (n) => (n === "box" && online.box ? (kit as unknown as NodeKit) : undefined),
  };
  return { kit, nodes, online, routes, layout, info };
}
```

Give `setup` a fourth parameter `nodes?: NodeKitsPort` and pass `nodes` into the `Orchestrator` deps. Then add helpers:

```ts
/** A started project with a remote environment for `fix` on box recorded (not started). */
async function withRemote() {
  const box = boxKit();
  const s = setup(undefined, undefined, undefined, box.nodes);
  await s.orch.rescan();
  await s.orch.start(project.id);
  s.store.putEnvironment({ id: remoteEnv, projectId: project.id, worktree: remoteFix, node: "box" });
  return { ...s, box };
}

/** …and started. */
async function withRemoteRunning() {
  const s = await withRemote();
  await s.orch.startEnv(project.id, remoteEnv);
  return s;
}
```

- [ ] **Step 2: Write the failing tests**

Add to `test/server/orchestrator.test.ts`:

```ts
describe("environments on another node", () => {
  it("start with that node's tools, mounting the node's repository", async () => {
    const { orch, store, containers, images, box } = await withRemote();
    await orch.startEnv(project.id, remoteEnv);
    expect(box.kit.images.ensureBase).toHaveBeenCalledWith(project, remoteFix, [], expect.any(Function));
    expect(images.ensureBase).not.toHaveBeenCalled();
    expect(box.kit.containers.readConfig).toHaveBeenCalledWith(remoteFix.hostPath);
    const config = box.kit.envFiles.write.mock.calls[0][1];
    expect(config.mounts).toContain(
      `type=bind,source=/home/tim/.opendevhub/repos/${project.id}/demo/.git,target=/workspaces/demo/.git`,
    );
    expect(box.kit.containers.up).toHaveBeenCalledWith(
      {
        id: remoteEnv,
        path: remoteFix.hostPath,
        idLabels: envLabels(remoteEnv, project.id),
        overrideConfig: `/home/tim/.opendevhub/envs/${remoteEnv}/devcontainer.json`,
      },
      expect.anything(),
    );
    expect(containers.up).toHaveBeenCalledTimes(1);
    expect(box.kit.network.route).toHaveBeenCalled();
    expect(box.kit.runtime.ensureRunning).toHaveBeenCalled();
    expect(store.runtime(remoteEnv)).toMatchObject({ containerState: "running", opencode: "healthy", containerId: "r1" });
  });

  it("start while the project's own container is stopped", async () => {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    s.store.putEnvironment({ id: remoteEnv, projectId: project.id, worktree: remoteFix, node: "box" });
    await s.orch.startEnv(project.id, remoteEnv);
    expect(s.store.runtime(remoteEnv).containerState).toBe("running");
  });

  it("fail with 'node box is unreachable' while it's offline, without touching their state", async () => {
    const { orch, store, box } = await withRemoteRunning();
    box.online.box = false;
    expect(() => orch.stopEnv(project.id, remoteEnv)).toThrow(UnavailableError);
    expect(() => orch.startEnv(project.id, remoteEnv)).toThrow("node box is unreachable");
    expect(store.runtime(remoteEnv).containerState).toBe("running");
  });

  it("are skipped when the project stops while their node is offline", async () => {
    const { orch, store, box } = await withRemoteRunning();
    box.online.box = false;
    await orch.stop(project.id);
    expect(store.runtime(project.id).containerState).toBe("stopped");
    expect(box.kit.containers.stop).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm vitest run test/server/orchestrator.test.ts -t "another node"`
Expected: FAIL. `nodes` is not a dep, and the local tools are used.

- [ ] **Step 4: Implement**

In `src/server/orchestrator.ts`:

1. Imports: add `NodeId` to the shared type import; add `import { LOCAL_NODE } from "./host";` and `import type { NodeRepoPort } from "./node-repo";`.

2. After `export type AgentTunnelFactory = …`, add the `NodeKit` and `NodeKitsPort` interfaces from the Interfaces block above, each with a one-line doc comment ("Everything that acts on one node's Docker and files; the local node's come from the deps above." and "The other nodes: a kit while a node is online."). Then add:

```ts
/** The local node's kit: the deps as they are, where images and a repo may be missing. */
type Kit = Omit<NodeKit, "images" | "repo"> & { images?: ImagesPort; repo?: NodeRepoPort };

const DIRECT: NetworkPort = { route: async (c: RouteContainer) => directRoute(c.ip) };
```

3. `OrchestratorDeps`: add

```ts
  /** Other nodes' kits; absent when nodes aren't wired (and then every environment is local). */
  nodes?: NodeKitsPort;
```

4. `Env`: add `/** Where its container runs. */ node: NodeId;`. `mainEnv` returns `{ id: project.id, project, node: LOCAL_NODE, target: project }`. `taskEnv` becomes:

```ts
  private taskEnv(project: Project, rec: EnvRecord): TaskEnv {
    const node = rec.node ?? LOCAL_NODE;
    // An offline node has no kit, so no config path; every action on it fails in kit() first.
    const files = node === LOCAL_NODE ? this.envFiles() : this.deps.nodes?.kit(node)?.envFiles;
    return {
      id: rec.id,
      project,
      node,
      worktree: rec.worktree,
      target: {
        id: rec.id,
        path: rec.worktree.hostPath,
        idLabels: envLabels(rec.id, project.id),
        ...(files ? { overrideConfig: files.path(rec.id) } : {}),
      },
    };
  }
```

5. Add next to `envFiles()`:

```ts
  /** The tools for an environment's node; throws while that node is offline. */
  private kit(env: Env): Kit {
    const kit = this.kitOf(env.node);
    if (!kit) throw new UnavailableError(`node ${env.node} is unreachable`);
    return kit;
  }

  private kitOf(node: NodeId): Kit | undefined {
    if (node !== LOCAL_NODE) return this.deps.nodes?.kit(node);
    const d = this.deps;
    return {
      containers: d.containers,
      runtime: d.runtime,
      relay: d.relay,
      images: d.images,
      envFiles: this.envFiles(),
      credentials: d.credentials,
      network: d.network ?? DIRECT,
      git: d.git,
    };
  }

  /** The project's .git as a task container mounts it: from this machine, or from the node's repository. */
  private gitDirOf(env: TaskEnv): { host: string; container: string } {
    const ws = this.workspaceFolder(env.project);
    const container = path.posix.join(ws, ".git");
    if (env.node === LOCAL_NODE) return { host: path.join(env.project.path, ".git"), container };
    return { host: this.kit(env).repo!.layout(env.project, ws).gitDir, container };
  }
```

6. Use the kit wherever a method acts on an `env`:
   - `refreshContainers`: at the top of the loop body, `const kit = this.kitOf(env.node); if (!kit) continue;`, and call `kit.containers.inspect(rt.containerId)`.
   - `adoptRunning`: `const { runtime } = this.kit(env);` in place of the deps' runtime (keep `store` from deps).
   - `stopContainer`: `const { store } = this.deps; const { runtime, relay, containers } = this.kit(env);` and use `relay.stop` in place of `this.deps.relay.stop`.
   - `bringUpTask`: `const { store } = this.deps; const kit = this.kit(env);`. Guard the "start the project first" check with `env.node === LOCAL_NODE &&`. Use `kit.images`, `kit.containers.readConfig`, `gitDir: this.gitDirOf(env)`, `kit.envFiles.write`, and `kit.containers.inspect`.
   - `upTask`: replace the single `taskUps` promise with `private readonly taskUps = new Map<NodeId, Promise<unknown>>();` and:

```ts
  private upTask(env: TaskEnv): ReturnType<ContainersPort["up"]> {
    const { containers } = this.kit(env);
    const next = (this.taskUps.get(env.node) ?? Promise.resolve()).then(() =>
      containers.up(env.target, { rebuild: false, onLine: (l) => this.envLog(env, l) }),
    );
    this.taskUps.set(env.node, next.catch(() => {}));
    return next;
  }
```

     Update the doc comment of the field: "Task containers come up one at a time per node: …".
   - `destroyEnv`: `const { store } = this.deps; const kit = this.kit(env);`, then `kit.containers.inspect/remove/removeImage` and `kit.envFiles.remove`.
   - `launchOpencode`: `this.kit(env).runtime.ensureRunning(…)`.
   - `forwardPorts`: `const { store, forwarder } = this.deps; const { containers } = this.kit(env);`.
   - `openRoute`: `const route = await this.kit(env).network.route(container, (line) => this.envLog(env, line));`.
   - `startRelay`: `const { store } = this.deps; const { runtime, relay } = this.kit(env);`.
   - `prepareCredentials`: `const { store } = this.deps; const { credentials } = this.kit(env);`.
   - `stop(id)`: in the environments loop, `if (!this.kitOf(env.node)) continue;` before the busy check.
   - `startEnv`, `stopEnv`, `removeEnv`: call `this.kit(env);` right after `requireTaskEnv`, so an offline node throws before anything changes.
   - `opencodeClient`: as its first lines:

```ts
    const env = this.envOf(id);
    if (env && env.node !== LOCAL_NODE && !this.kitOf(env.node)) throw new UnavailableError(`node ${env.node} is unreachable`);
```

`startMonitor` and `opencodeClient` keep `this.deps.runtime.endpoint`, which is pure.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run test/server/orchestrator.test.ts && pnpm typecheck`
Expected: PASS, including every test that existed before.

- [ ] **Step 6: Commit**

```bash
git add src/server/orchestrator.ts test/server/orchestrator.test.ts
git commit -m "refactor(server): each environment runs with its node's tools"
```

---

### Task 6: Adopt a node when it comes online, park it when it drops

**Files:**
- Modify: `src/server/orchestrator.ts`
- Test: `test/server/orchestrator.test.ts`

**Interfaces:**
- Consumes: Task 5's kits.
- Produces: `Orchestrator.nodeOnline(node: NodeId): Promise<void>`, `Orchestrator.nodeOffline(node: NodeId): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Add inside `describe("environments on another node", …)`:

```ts
  it("are parked when their node drops: watching stops, state and sessions stay", async () => {
    const { orch, store, monitors, forwarder, box } = await withRemoteRunning();
    const session = { ...waiting({ permissions: [], forms: [] }), id: "ses_r", envId: remoteEnv, directory: remoteFix.path, status: "idle" as const };
    store.setSessions(remoteEnv, [session]);
    box.online.box = false;
    await orch.nodeOffline("box");
    expect(monitors.find((m) => m.opts.envId === remoteEnv)?.stopped).toBe(true);
    expect(forwarder.close).toHaveBeenCalledWith(remoteEnv);
    expect(box.routes[0].close).toHaveBeenCalled();
    expect(store.runtime(remoteEnv).containerState).toBe("running");
    expect(store.sessionsOf(project.id).map((s) => s.id)).toContain("ses_r");
    await expect(orch.promptSession(project.id, "ses_r", "hi")).rejects.toThrow("node box is unreachable");
  });

  it("are adopted again when their node comes back", async () => {
    const { orch, store, monitors, box } = await withRemoteRunning();
    box.online.box = false;
    await orch.nodeOffline("box");
    box.online.box = true;
    box.kit.containers.listManaged.mockResolvedValue([box.info]);
    await orch.nodeOnline("box");
    expect(store.runtime(remoteEnv)).toMatchObject({ containerState: "running", opencode: "healthy" });
    expect(monitors.filter((m) => m.opts.envId === remoteEnv && m.started && !m.stopped)).toHaveLength(1);
  });

  it("are marked stopped when their container is gone after the node comes back", async () => {
    const { orch, store, box } = await withRemoteRunning();
    box.kit.containers.listManaged.mockResolvedValue([]);
    await orch.nodeOnline("box");
    expect(store.runtime(remoteEnv).containerState).toBe("stopped");
  });

  it("are left alone by the refresh while offline, or when ssh fails", async () => {
    const { orch, store, box } = await withRemoteRunning();
    box.kit.containers.inspect.mockRejectedValueOnce(new CommandError("docker inspect could not run: ssh exited 255"));
    await orch.refreshContainers();
    expect(store.runtime(remoteEnv).containerState).toBe("running");
    box.online.box = false;
    box.kit.containers.inspect.mockClear();
    await orch.refreshContainers();
    expect(box.kit.containers.inspect).not.toHaveBeenCalled();
    expect(store.runtime(remoteEnv).containerState).toBe("running");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/orchestrator.test.ts -t "another node"`
Expected: FAIL, because `nodeOnline` and `nodeOffline` don't exist.

- [ ] **Step 3: Implement**

Add to `Orchestrator`, after `refreshContainers`:

```ts
  /** A node came (back) online: adopt its containers as at startup; environments whose container is gone stop. */
  async nodeOnline(node: NodeId): Promise<void> {
    const kit = this.kitOf(node);
    if (!kit || node === LOCAL_NODE) return;
    let managed: ContainerInfo[];
    try {
      managed = await kit.containers.listManaged();
    } catch {
      return;
    }
    const { store } = this.deps;
    for (const project of store.projects()) {
      for (const rec of store.environments(project.id)) {
        if (rec.node !== node || this.busy.has(rec.id)) continue;
        const info = managed.find((i) => i.envId === rec.id);
        if (info) await this.adoptTask(info);
        else if (store.runtime(rec.id).containerState !== "stopped") await this.markStopped(this.taskEnv(project, rec));
      }
    }
  }

  /** A node dropped: stop watching its environments and close their routes. Their state and sessions stay as last seen. */
  async nodeOffline(node: NodeId): Promise<void> {
    for (const env of this.allEnvs()) {
      if (env.node !== node) continue;
      this.stopMonitor(env.id);
      await this.closePorts(env.id);
      await this.closeRoute(env.id);
    }
  }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/orchestrator.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator.ts test/server/orchestrator.test.ts
git commit -m "feat(server): adopt a node's environments when it comes online, park them when it drops"
```

---

### Task 7: Placing a task's variants on a node

**Files:**
- Modify: `src/server/orchestrator.ts`
- Test: `test/server/orchestrator.test.ts`

**Interfaces:**
- Consumes: `TaskRequest.node` (Task 2); `NodeRepoPort` (Task 4); kits (Task 5).
- Produces: `createTask` with `node` set creates its worktrees on the node and starts their environments there. `recordTaskEnv` and `ensureTaskEnv` take a `node` (default `LOCAL_NODE`). `checkDirectory` accepts remote environments' paths. `createWorktree` refuses a path a remote environment holds.

- [ ] **Step 1: Write the failing tests**

Add inside `describe("environments on another node", …)`:

```ts
  async function remoteTask(body: Record<string, unknown> = {}) {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    await s.orch.start(project.id);
    const result = await s.orch.createTask(project.id, { prompt: "Fix login", environment: "isolated", node: "box", ...body });
    return { ...s, box, result };
  }

  it("place a task: push the base, worktree on the node, environment there", async () => {
    const { result, box, worktrees, store, client } = await remoteTask();
    const layout = box.layout(project, "/workspaces/demo");
    expect(box.kit.repo.ensure).toHaveBeenCalledWith(layout);
    expect(box.kit.repo.pushBase).toHaveBeenCalledWith(project, layout, "main");
    expect(box.kit.repo.addWorktree).toHaveBeenCalledWith(layout, "fix-login", "main");
    expect(worktrees.add).not.toHaveBeenCalled();
    const v = result.variants[0];
    expect(v).toMatchObject({ branch: "fix-login", directory: "/workspaces/demo.worktrees/fix-login", sessionId: "ses_new" });
    expect(store.environment(v.envId!)).toMatchObject({ node: "box", worktree: { branch: "fix-login" } });
    expect(v.envId).toBe(envIdFor(project.id, "box:/workspaces/demo.worktrees/fix-login", "fix-login"));
    expect(client.createSession).toHaveBeenCalledWith("/workspaces/demo.worktrees/fix-login", expect.anything());
    expect(box.kit.containers.up).toHaveBeenCalled();
  });

  it("avoid branch names the node already has, and use the requested base", async () => {
    const box = boxKit();
    box.kit.repo.branches.mockResolvedValue(["fix-login"]);
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    await s.orch.start(project.id);
    const result = await s.orch.createTask(project.id, { prompt: "Fix login", environment: "isolated", node: "box", base: "origin/main" });
    expect(result.variants[0].branch).not.toBe("fix-login");
    expect(box.kit.repo.pushBase).toHaveBeenCalledWith(project, expect.anything(), "origin/main");
  });

  it("say when the main checkout's uncommitted changes stay behind", async () => {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    await s.orch.start(project.id);
    s.git.isClean.mockResolvedValue(false);
    const result = await s.orch.createTask(project.id, { prompt: "x", environment: "isolated", node: "box" });
    expect(result.variants[0].notice).toBe("uncommitted changes in the main checkout are not on node box");
  });

  it("refuse what can't run on a node", async () => {
    const box = boxKit();
    const s = setup(undefined, undefined, undefined, box.nodes);
    await s.orch.rescan();
    await s.orch.start(project.id);
    const task = (body: Record<string, unknown>) => s.orch.createTask(project.id, { prompt: "x", ...body });
    await expect(task({ where: "workspace", node: "box" })).rejects.toThrow(InvalidRequestError);
    await expect(task({ environment: "shared", node: "box" })).rejects.toThrow(/needs a new worktree with its own container/);
    await expect(task({ environment: "isolated", node: "nope" })).rejects.toThrow("unknown node nope");
    s.git.currentBranch.mockResolvedValue(undefined);
    await expect(task({ environment: "isolated", node: "box" })).rejects.toThrow(/detached HEAD/);
    box.online.box = false;
    await expect(task({ environment: "isolated", node: "box" })).rejects.toThrow("node box is unreachable");
    s.store.setIsolation(project.id, { default: "shared", unsupported: "host networking is not supported" });
    box.online.box = true;
    await expect(task({ environment: "isolated", node: "box" })).rejects.toThrow(/can't run on another node: host networking/);
  });

  it("accept their checkouts as known directories", async () => {
    const { orch, result } = await remoteTask();
    await expect(orch.review(project.id, result.variants[0].directory!)).resolves.toBeDefined();
  });

  it("keep a local worktree from taking a remote environment's path", async () => {
    const { orch } = await remoteTask();
    await expect(orch.createWorktree(project.id, { branch: "fix-login" })).rejects.toThrow(/used by a task on node box/);
  });
```

The `review` call in "accept their checkouts" uses the local git fake until Task 9 routes it to the node's git; Task 9 tightens the assertion.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/orchestrator.test.ts -t "another node"`
Expected: FAIL. The task is created locally, the node is ignored, and the review rejects the directory.

- [ ] **Step 3: Implement**

In `src/server/orchestrator.ts`:

1. Import `worktreeDirName` from `./worktrees`, add `TaskRequest` to the shared type import, and `NodeRepoLayout` to the `./node-repo` type import.

2. Add the helpers:

```ts
  /** The kit a task placed on `node` runs with; throws when the request or the node rules that out. */
  private remoteKitFor(project: Project, req: TaskRequest, node: NodeId): NodeKit {
    if (req.where !== "worktree" || req.environment === "shared") {
      throw new InvalidRequestError("a task on another node needs a new worktree with its own container");
    }
    if (!this.deps.nodes?.known(node)) throw new InvalidRequestError(`unknown node ${node}`);
    const unsupported = this.deps.store.isolation(project.id)?.unsupported;
    if (unsupported) throw new InvalidRequestError(`${project.name} can't run on another node: ${unsupported}`);
    const kit = this.deps.nodes.kit(node);
    if (!kit) throw new UnavailableError(`node ${node} is unreachable`);
    return kit;
  }

  /** The node's repository for the project, with the base pushed to it. */
  private async prepareRemote(
    p: Project,
    ws: string,
    kit: NodeKit,
    node: NodeId,
    requested: string | undefined,
  ): Promise<{ layout: NodeRepoLayout; base: string; notice?: string }> {
    const base = requested ?? (await this.deps.git.currentBranch(p, ws));
    if (!base) throw new InvalidRequestError("the main checkout is on a detached HEAD; choose a base branch for a task on another node");
    const layout = kit.repo.layout(p, ws);
    await kit.repo.ensure(layout);
    await kit.repo.pushBase(p, layout, base);
    this.log(p.id, `task: pushed ${base} to node ${node}`);
    const clean = await this.deps.git.isClean(p, ws);
    return { layout, base, ...(clean ? {} : { notice: `uncommitted changes in the main checkout are not on node ${node}` }) };
  }
```

3. In `createTask`:
   - After `const project = this.requireProject(id);`:

```ts
    const node = req.node ?? LOCAL_NODE;
    const remoteKit = node === LOCAL_NODE ? undefined : this.remoteKitFor(project, req, node);
```

     and compute `isolated` and `notice` as `remoteKit ? { isolated: true, notice: undefined } : <the existing expression>`.
   - Inside `withGit`, replace the `if (req.where === "worktree") { … }` block with:

```ts
      let remote: { layout: NodeRepoLayout; base: string; notice?: string } | undefined;
      if (req.where === "worktree") {
        if (!remoteKit && !root?.mounted) throw new UnavailableError(NO_WORKTREE_MOUNT);
        if (remoteKit) remote = await this.prepareRemote(p, ws, remoteKit, node, req.base);
        const taken = new Set([
          ...(await this.deps.git.localBranches(p, ws)),
          ...(rt.worktrees ?? []).flatMap((w) => (w.branch ? [w.branch] : [])),
          ...(remote ? await remoteKit!.repo.branches(remote.layout) : []),
        ]);
        branches = taskBranches({ branch: req.branch, title, variants: req.variants, taken }).map(validateBranch);
      }
```

   - In the variants loop, after `if (notice) result.notice = notice;` add `if (remote?.notice) result.notice = remote.notice;`. Inside `try`, before the existing `if (branch) {`:

```ts
          if (branch && remote) {
            const wt = await remoteKit!.repo.addWorktree(remote.layout, branch, remote.base);
            result.directory = wt.path;
            own[i] = wt;
            continue;
          }
```

   - Change `if (branches.length > 0) {` (the worktree list refresh) to `if (branches.length > 0 && !remote) {`.
   - In the `own.map` callback, call `this.ensureTaskEnv(project, worktree, node)`.

4. `recordTaskEnv` and `ensureTaskEnv` take `node: NodeId = LOCAL_NODE`. `ensureTaskEnv` passes it on. `recordTaskEnv` becomes:

```ts
  private recordTaskEnv(project: Project, worktree: EnvWorktree, node: NodeId = LOCAL_NODE): TaskEnv {
    const { store } = this.deps;
    const existing = store.environments(project.id).find((e) => e.worktree.path === worktree.path && (e.node ?? LOCAL_NODE) === node);
    if (existing) return this.taskEnv(project, existing);
    // A remote worktree can sit at the same container path as a local one; its id must not.
    const key = node === LOCAL_NODE ? worktree.path : `${node}:${worktree.path}`;
    const rec: EnvRecord = {
      id: envIdFor(project.id, key, worktree.branch),
      projectId: project.id,
      worktree,
      ...(node === LOCAL_NODE ? {} : { node }),
    };
    store.putEnvironment(rec);
    return this.taskEnv(project, rec);
  }
```

   `createEnv` keeps calling it without a node.

5. `checkDirectory`: before the `throw`, add

```ts
    if (this.deps.store.environments(id).some((e) => e.worktree.path === directory)) return;
```

6. `noticeDirectories`: build `known` from the local worktrees and the environments' paths:

```ts
    const known = new Set([
      ...(this.deps.store.runtime(id).worktrees ?? []).map((w) => w.path),
      ...this.deps.store.environments(id).map((e) => e.worktree.path),
    ]);
```

7. `createWorktree`: inside `withGit`, after the `root?.mounted` check:

```ts
      const target = path.posix.join(root.container, worktreeDirName(branch));
      const held = this.deps.store.environments(id).find((e) => e.node && e.worktree.path === target);
      if (held) throw new InvalidRequestError(`${target} is used by a task on node ${held.node}; remove that task first`);
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/orchestrator.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator.ts test/server/orchestrator.test.ts
git commit -m "feat(server): place a task's variants on another node"
```

---

### Task 8: Removing remote environments

**Files:**
- Modify: `src/server/orchestrator.ts`
- Test: `test/server/orchestrator.test.ts`

**Interfaces:**
- Produces: `destroyEnv` on a remote environment also removes its worktree and branch on the node. `removeWorktree` on a remote path destroys that environment, and doesn't need the main container. `pickVariant` with `removeWorktrees` removes discarded remote variants the same way.

- [ ] **Step 1: Write the failing tests**

Add inside `describe("environments on another node", …)`:

```ts
  it("are removed with their worktree and branch on the node", async () => {
    const { orch, store, box } = await withRemoteRunning();
    await orch.removeEnv(project.id, remoteEnv);
    expect(box.kit.containers.remove).toHaveBeenCalledWith("r1");
    expect(box.kit.envFiles.remove).toHaveBeenCalledWith(remoteEnv);
    expect(box.kit.repo.removeWorktree).toHaveBeenCalledWith(box.layout(project, "/workspaces/demo"), remoteFix);
    expect(store.environment(remoteEnv)).toBeUndefined();
  });

  it("keep their record when the node's worktree won't go", async () => {
    const { orch, store, box } = await withRemoteRunning();
    box.kit.repo.removeWorktree.mockRejectedValueOnce(new CommandError("removing worktree fix on box failed: busy"));
    await expect(orch.removeEnv(project.id, remoteEnv)).rejects.toThrow(/busy/);
    expect(store.environment(remoteEnv)).toBeDefined();
  });

  it("are removed as worktrees, even while the project's container is stopped", async () => {
    const { orch, store, box, worktrees } = await withRemoteRunning();
    await orch.stop(project.id);
    store.updateRuntime(project.id, { containerState: "stopped" });
    box.kit.repo.removeWorktree.mockClear();
    await orch.removeWorktree(project.id, remoteFix.path, false);
    expect(box.kit.repo.removeWorktree).toHaveBeenCalled();
    expect(worktrees.remove).not.toHaveBeenCalled();
    expect(store.environment(remoteEnv)).toBeUndefined();
  });

  it("are removed when another variant is picked", async () => {
    const { orch, store, box } = await withRemoteRunning();
    const local = { ...waiting({ permissions: [], forms: [] }), id: "ses_keep", status: "idle" as const, directory: "/workspaces/demo",
      task: { task: "tsk_1", variant: 1, of: 2, title: "t" } };
    const remote = { ...local, id: "ses_r", envId: remoteEnv, directory: remoteFix.path, task: { task: "tsk_1", variant: 2, of: 2, title: "t", branch: "fix" } };
    store.setSessions(project.id, [local]);
    store.setSessions(remoteEnv, [remote]);
    const result = await orch.pickVariant(project.id, "tsk_1", "ses_keep", true);
    expect(result.removed).toEqual([remoteFix.path]);
    expect(box.kit.repo.removeWorktree).toHaveBeenCalled();
    expect(store.environment(remoteEnv)).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/orchestrator.test.ts -t "another node"`
Expected: FAIL. The node's worktree is left, and `removeWorktree` rejects the unknown path.

- [ ] **Step 3: Implement**

1. `destroyEnv`: after the `envFiles.remove` line and before `store.removeEnvironment(env.id)`:

```ts
    if (env.node !== LOCAL_NODE) {
      // The worktree and branch exist only for this environment; a branch brought home stays on this machine.
      await kit.repo!.removeWorktree(kit.repo!.layout(env.project, this.workspaceFolder(env.project)), env.worktree);
    }
```

2. Add the helper:

```ts
  /** The remote environment whose worktree is `directory`, if one is. */
  private remoteEnvAt(project: Project, directory: string): TaskEnv | undefined {
    const rec = this.deps.store.environments(project.id).find((e) => e.node && e.worktree.path === directory);
    return rec ? this.taskEnv(project, rec) : undefined;
  }
```

3. `removeWorktree`: at the start of the method:

```ts
    const remote = this.remoteEnvAt(this.requireProject(id), worktreePath);
    if (remote) {
      this.kit(remote);
      return this.exclusiveEnv(remote, () => this.destroyEnv(remote));
    }
```

4. `pickVariant`: move the `fail` helper above `for (const dir of dirs) {`. At the start of the loop body:

```ts
        const remote = this.remoteEnvAt(p, dir);
        if (remote) {
          try {
            this.kit(remote);
            await this.exclusiveEnv(remote, () => this.destroyEnv(remote));
            result.removed.push(dir);
            this.log(id, `task: removed ${dir} and branch ${remote.worktree.branch} on node ${remote.node}`);
          } catch (err) {
            result.errors.push(`${remote.worktree.branch}: kept — ${fail(err)}`);
          }
          continue;
        }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/orchestrator.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator.ts test/server/orchestrator.test.ts
git commit -m "feat(server): removing a remote environment removes its worktree and branch on the node"
```

---

### Task 9: Git actions, Bring home, merge and publish for remote environments

**Files:**
- Modify: `src/server/orchestrator.ts`, `src/server/dashboard-api.ts`
- Test: `test/server/orchestrator.test.ts`, `test/server/dashboard-api.test.ts`

**Interfaces:**
- Produces:
  - `Orchestrator.bringHome(id: ProjectId, directory: string): Promise<{ branch: string }>`.
  - `POST /api/projects/:id/review/bring-home` with `{ directory }` returns `{ branch }`.
  - `review`, `commit` and `updateFromBase` on a remote checkout run git in its environment's container on the node. `updateFromBase` pushes the base again first. `mergeIntoBase` and `publish` bring the branch home, then work from the main checkout. `publishInfo` reads the main checkout. `checkTarget` says checks don't run there yet, and `openInEditor` refuses.

- [ ] **Step 1: Write the failing tests**

In Task 7's "accept their checkouts" test, tighten the assertion to `.resolves.toMatchObject({ branch: "fix" })`. Add inside `describe("environments on another node", …)`:

```ts
  it("review and commit with git in their own container", async () => {
    const { orch, box } = await withRemoteRunning();
    const data = await orch.review(project.id, remoteFix.path);
    expect(data).toMatchObject({ branch: "fix", ahead: 3 });
    expect(box.kit.git.currentBranch.mock.calls[0][0]).toMatchObject({ id: remoteEnv, path: remoteFix.hostPath });
    box.kit.git.isClean.mockResolvedValueOnce(false);
    await orch.commit(project.id, remoteFix.path, "fix: login");
    expect(box.kit.git.commit).toHaveBeenCalledWith(expect.objectContaining({ id: remoteEnv }), remoteFix.path, "fix: login");
  });

  it("update from the base after pushing it again", async () => {
    const { orch, box } = await withRemoteRunning();
    box.kit.repo.pushBase.mockClear();
    await orch.updateFromBase(project.id, remoteFix.path, "main");
    expect(box.kit.repo.pushBase).toHaveBeenCalledWith(project, box.layout(project, "/workspaces/demo"), "main");
    expect(box.kit.git.update).toHaveBeenCalledWith(expect.objectContaining({ id: remoteEnv }), remoteFix.path, "main", "rebase");
  });

  it("bring their branch home", async () => {
    const { orch, box } = await withRemoteRunning();
    expect(await orch.bringHome(project.id, remoteFix.path)).toEqual({ branch: "fix" });
    expect(box.kit.repo.bringHome).toHaveBeenCalledWith(project, box.layout(project, "/workspaces/demo"), "fix");
    await expect(orch.bringHome(project.id, "/workspaces/demo")).rejects.toThrow(/on this machine already/);
  });

  it("merge into the base after bringing the branch home", async () => {
    const { orch, box, git } = await withRemoteRunning();
    expect(await orch.mergeIntoBase(project.id, remoteFix.path, "main", true)).toEqual({ branch: "fix" });
    expect(box.kit.repo.bringHome).toHaveBeenCalled();
    expect(git.mergeInto).toHaveBeenCalledWith(project, "/workspaces/demo", "fix", true);
    expect(box.kit.repo.bringHome.mock.invocationCallOrder[0]).toBeLessThan(git.mergeInto.mock.invocationCallOrder[0]);
  });

  it("publish from the main checkout after bringing the branch home", async () => {
    const { orch, box, publisher } = await withRemoteRunning();
    const main = { container: "/workspaces/demo", host: project.path };
    await orch.publishInfo(project.id, remoteFix.path);
    expect(publisher.info).toHaveBeenCalledWith(project, main, "fix", undefined);
    await orch.publish(project.id, remoteFix.path, { remote: "origin", base: "main", strategy: "branch", title: "Fix", description: "" });
    expect(box.kit.repo.bringHome).toHaveBeenCalled();
    expect(publisher.publish).toHaveBeenCalledWith(project, main, "fix", expect.objectContaining({ remote: "origin" }));
  });

  it("don't run checks or open editors yet", async () => {
    const { orch, editors } = await withRemoteRunning();
    expect(orch.checkTarget(project.id, remoteFix.path).unavailable).toBe("checks don't run on other nodes yet");
    expect(() => orch.openInEditor(project.id, "code", remoteFix.path)).toThrow(/isn't available for environments on other nodes/);
    expect(editors.open).not.toHaveBeenCalled();
  });
```

In `test/server/dashboard-api.test.ts`, add `bringHome: vi.fn(async (_id: string, _dir: string) => ({ branch: "fix" })),` to the fake orchestrator in `setup`, and:

```ts
describe("bring home", () => {
  it("fetches a remote checkout's branch", async () => {
    const { app, orchestrator } = setup();
    const res = await app.request(`/api/projects/${project.id}/review/bring-home`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: "/workspaces/demo.worktrees/fix" }),
    });
    expect(await res.json()).toEqual({ branch: "fix" });
    expect(orchestrator.bringHome).toHaveBeenCalledWith(project.id, "/workspaces/demo.worktrees/fix");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/orchestrator.test.ts test/server/dashboard-api.test.ts`
Expected: FAIL. The local git is used, and `bringHome` and the route don't exist.

- [ ] **Step 3: Implement**

In `src/server/orchestrator.ts`:

1. Add:

```ts
  /** Where git runs for a checkout: the project's container, or a remote environment's own. */
  private gitFor(project: Project, directory: string): { git: GitPort; target: ExecTarget; remote?: TaskEnv } {
    const remote = this.remoteEnvAt(project, directory);
    if (!remote) return { git: this.deps.git, target: project };
    return { git: this.kit(remote).git, target: remote.target, remote };
  }

  /** Fetches a remote environment's branch into this machine's repository. */
  bringHome(id: ProjectId, directory: string): Promise<{ branch: string }> {
    this.checkDirectory(id, directory);
    return this.withGit(id, (p) => this.fetchHome(p, directory));
  }

  private async fetchHome(p: Project, directory: string): Promise<{ branch: string }> {
    const remote = this.remoteEnvAt(p, directory);
    if (!remote) throw new InvalidRequestError(`${directory} is on this machine already`);
    const kit = this.kit(remote);
    const branch = validateBranch((await kit.git.currentBranch(remote.target, directory)) ?? remote.worktree.branch);
    const layout = kit.repo!.layout(p, this.workspaceFolder(p));
    await this.gitAction(p.id, `bring ${branch} home from node ${remote.node}`, () => kit.repo!.bringHome(p, layout, branch));
    return { branch };
  }
```

2. `review`: after `const ws = this.workspaceFolder(project);`, add `const on = this.gitFor(project, directory);`. Make the calls that take `(project, directory, …)` use `on.git` and `on.target`: `currentBranch`, `recordedBase`, `aheadBehind` and `isPushed` on `directory`. The two calls on `ws` (`git.currentBranch(project, ws)`, `git.isClean(project, ws)`) stay on the local git.

3. `commit`: inside `withGit`:

```ts
      const on = this.gitFor(p, directory);
      if (await on.git.isClean(on.target, directory)) throw new InvalidRequestError("there is nothing to commit");
      await this.gitAction(id, `commit in ${directory}`, () => on.git.commit(on.target, directory, msg));
```

4. `updateFromBase`: inside `withGit`, replace `const { git } = this.deps;` with:

```ts
      const on = this.gitFor(p, directory);
      const git = on.git;
      if (on.remote) {
        const kit = this.kit(on.remote);
        // The base is always what this machine has, never a branch of the node's repository.
        await kit.repo!.pushBase(p, kit.repo!.layout(p, this.workspaceFolder(p)), ref);
      }
```

   and pass `on.target` in place of `p` to `currentBranch`, `isClean`, `isPushed` and `update`.

5. `mergeIntoBase`: inside `withGit`, after `const ws = …` and the main-checkout check, add `const on = this.gitFor(p, directory);`. Use `on.git.currentBranch(on.target, directory)` and `on.git.isClean(on.target, directory)` for the branch checks. The `ws` checks stay on the local git. Right before the `gitAction(… merge …)`, add `if (on.remote) await this.fetchHome(p, directory);`. `git.mergeInto(p, ws, branch, ffOnly)` is unchanged.

6. `publishInfo`:

```ts
    const on = this.gitFor(project, directory);
    const branch = await on.git.currentBranch(on.target, directory);
    // A node's repository has no remotes: its branch is published from this machine's checkout.
    const checkout = this.checkout(project, on.remote ? this.workspaceFolder(project) : directory);
    return this.deps.publisher.info(project, checkout, branch, remote);
```

7. `publish`: inside `withGit`, replace the branch lookup with `const on = this.gitFor(p, directory); const branch = await on.git.currentBranch(on.target, directory);`. Keep the two checks. Add `if (on.remote) await this.fetchHome(p, directory);` before publishing, and pass `this.checkout(p, on.remote ? this.workspaceFolder(p) : directory)` as the checkout.

8. `checkTarget`: after `this.checkDirectory(id, directory);`:

```ts
    const remote = this.remoteEnvAt(project, directory);
    if (remote) return { project, exec: remote.target, unavailable: "checks don't run on other nodes yet", checkout: { container: directory }, isMain: false };
```

9. `openInEditor`: after `this.checkDirectory(id, directory);`:

```ts
    if (this.remoteEnvAt(project, directory)) {
      throw new InvalidRequestError("opening an editor isn't available for environments on other nodes");
    }
```

In `src/server/dashboard-api.ts`, add `| "bringHome"` to `DashboardOrchestrator`, and after the `review/merge` route:

```ts
  app.post("/api/projects/:id/review/bring-home", (c) => json(c, (id, b) => orchestrator.bringHome(id, str(b.directory) ?? "")));
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run test/server/orchestrator.test.ts test/server/dashboard-api.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/orchestrator.ts src/server/dashboard-api.ts test/server/orchestrator.test.ts test/server/dashboard-api.test.ts
git commit -m "feat(server): review, update, bring home, merge and publish remote environments"
```

---

### Task 10: Building node kits, and wiring them in

**Files:**
- Create: `src/server/node-kits.ts`
- Modify: `src/server/cli.ts`
- Test: `test/server/node-kits.test.ts`

**Interfaces:**
- Consumes: `Nodes.connection`, the `onOnline`/`onOffline` options and `NodeConnectionPort.target` (Task 1); `NodeKit`, `NodeKitsPort`, `nodeOnline`/`nodeOffline` (Tasks 5 and 6); `NodeRepo` (Task 4); `hostHeadObjects`, `EnvFiles(dir, host)` (Task 3); `sshRoute` (Plan 1).
- Produces:

```ts
export class NodeKits implements NodeKitsPort {
  constructor(opts: { nodes: Pick<Nodes, "connection">; build: (conn: NodeConnectionPort) => NodeKit });
}
export function buildNodeKit(conn: NodeConnectionPort, deps: { clientFor: (ep: OpencodeEndpoint) => OpencodeClient; local: Runner }): NodeKit;
```

- [ ] **Step 1: Write the failing tests**

Create `test/server/node-kits.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { Containers } from "../../src/server/containers";
import { localHost } from "../../src/server/host";
import { NodeKits, buildNodeKit } from "../../src/server/node-kits";
import type { NodeConnectionPort } from "../../src/server/nodes";
import type { NodeKit } from "../../src/server/orchestrator";
import type { OpencodeClient } from "../../src/server/opencode/client";
import { fakeRunner } from "../helpers/fake-runner";

function conn(online: boolean): NodeConnectionPort {
  return {
    host: { ...localHost(fakeRunner().run), id: "box", home: "/home/tim" },
    online,
    target: { dest: "tim@box", control: "/ctl/box.sock" },
    view: () => ({ id: "box", label: "box", state: online ? "online" : "unreachable" }),
    start: () => {},
    close: async () => {},
  };
}

describe("NodeKits", () => {
  it("hands out a kit only while the node is online, built once per connection", () => {
    let current: NodeConnectionPort | undefined = conn(true);
    const build = vi.fn((_c: NodeConnectionPort) => ({}) as NodeKit);
    const kits = new NodeKits({ nodes: { connection: (id) => (id === "box" ? current : undefined) }, build });
    expect(kits.known("box")).toBe(true);
    expect(kits.known("nope")).toBe(false);
    const first = kits.kit("box");
    expect(first).toBeDefined();
    expect(kits.kit("box")).toBe(first);
    expect(build).toHaveBeenCalledTimes(1);
    current = conn(false);
    expect(kits.kit("box")).toBeUndefined();
    current = conn(true);
    expect(kits.kit("box")).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(2);
    current = undefined;
    expect(kits.kit("box")).toBeUndefined();
  });
});

describe("buildNodeKit", () => {
  it("builds every tool on the node's host, with files under its home", async () => {
    const kit = buildNodeKit(conn(true), { clientFor: () => ({}) as OpencodeClient, local: fakeRunner().run });
    expect(kit.containers).toBeInstanceOf(Containers);
    expect(kit.envFiles.path("demo-fix-1a2b")).toBe("/home/tim/.opendevhub/envs/demo-fix-1a2b/devcontainer.json");
    expect(kit.repo.layout({ id: "demo", name: "demo", path: "/src/demo", devcontainerPath: "" }, "/workspaces/demo").repo).toBe(
      "/home/tim/.opendevhub/repos/demo/demo",
    );
    const route = await kit.network.route({ id: "c", ip: "172.18.0.4" }, () => {});
    expect(route.kind).toBe("ssh");
    await route.close();
  });

  it("needs the connection's ssh target", () => {
    const { target: _t, ...without } = conn(true);
    expect(() => buildNodeKit(without, { clientFor: () => ({}) as OpencodeClient, local: fakeRunner().run })).toThrow(/no ssh target/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/server/node-kits.test.ts`
Expected: FAIL, because the module doesn't exist.

- [ ] **Step 3: Implement**

Create `src/server/node-kits.ts`:

```ts
import path from "node:path";
import type { NodeId } from "../shared/types";
import { Containers } from "./containers";
import { Credentials } from "./credentials";
import { EnvFiles } from "./env-files";
import type { Runner } from "./exec";
import { GitOps, hostHeadObjects } from "./git";
import { Images } from "./images";
import { sshRoute } from "./network";
import { NodeRepo } from "./node-repo";
import type { NodeConnectionPort, Nodes } from "./nodes";
import type { OpencodeClient, OpencodeEndpoint } from "./opencode/client";
import { OpencodeRuntime } from "./opencode/runtime";
import type { NodeKit, NodeKitsPort } from "./orchestrator";
import { RelayRuntime } from "./relay/runtime";

/** One kit per online node, rebuilt when its connection is replaced (the node was removed and added again). */
export class NodeKits implements NodeKitsPort {
  private readonly cache = new Map<NodeId, { conn: NodeConnectionPort; kit: NodeKit }>();

  constructor(private readonly opts: { nodes: Pick<Nodes, "connection">; build: (conn: NodeConnectionPort) => NodeKit }) {}

  known(node: NodeId): boolean {
    return this.opts.nodes.connection(node) !== undefined;
  }

  kit(node: NodeId): NodeKit | undefined {
    const conn = this.opts.nodes.connection(node);
    if (!conn?.online) return undefined;
    const hit = this.cache.get(node);
    if (hit?.conn === conn) return hit.kit;
    const kit = this.opts.build(conn);
    this.cache.set(node, { conn, kit });
    return kit;
  }
}

/** The orchestrator's per-environment tools, built on a node's ssh host. git on this machine stays local. */
export function buildNodeKit(
  conn: NodeConnectionPort,
  deps: { clientFor: (ep: OpencodeEndpoint) => OpencodeClient; local: Runner },
): NodeKit {
  const { host, target } = conn;
  if (!target) throw new Error(`node ${host.id} has no ssh target`);
  const containers = new Containers(host.run);
  return {
    containers,
    runtime: new OpencodeRuntime({ containers, clientFor: deps.clientFor }),
    relay: new RelayRuntime({ containers }),
    images: new Images({ run: host.run, containers, objects: (_p, wt, paths) => hostHeadObjects(host.run, wt.hostPath, paths) }),
    envFiles: new EnvFiles(path.posix.join(host.home, ".opendevhub", "envs"), host),
    // Identity and known_hosts are read from this machine's repository and ~/.ssh.
    credentials: new Credentials({ run: deps.local, containers }),
    network: { route: (c) => sshRoute(host, c.ip) },
    git: new GitOps({ containers }),
    repo: new NodeRepo({ node: host.id, host, target, local: deps.local }),
  };
}
```

If the typecheck reports that a constructor's deps type differs (for example, `OpencodeRuntime` or `Credentials` requiring more fields), copy the fields from how `cli.ts` constructs them for the local node.

In `src/server/cli.ts`:
- Import `NodeKits, buildNodeKit` from `./node-kits`.
- Change the `Nodes` construction to:

```ts
  const nodes = new Nodes({
    configDir: dir,
    controlDir: path.join(dir, "ssh"),
    store,
    onOnline: (id) => void orchestrator.nodeOnline(id).catch(() => {}),
    onOffline: (id) => void orchestrator.nodeOffline(id).catch(() => {}),
  });
```

  and remove `nodes.start();` from there.
- Construct the kits after `clientFor` exists:

```ts
  const kits = new NodeKits({ nodes, build: (conn) => buildNodeKit(conn, { clientFor, local: spawnRunner }) });
```

  and pass `nodes: kits` into the `Orchestrator` deps.
- Call `nodes.start();` right after `if (store.preflight().errors.length === 0) await orchestrator.adopt();`, so nodes adopt after the local containers do. The callbacks only fire once `orchestrator` exists.

- [ ] **Step 4: Run tests, typecheck and build**

Run: `pnpm vitest run test/server/node-kits.test.ts test/server/cli.test.ts && pnpm typecheck && pnpm build`
Expected: PASS, and the build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/server/node-kits.ts src/server/cli.ts test/server/node-kits.test.ts
git commit -m "feat(server): build node kits from connections and wire nodes into the orchestrator"
```

---

### Task 11: Choosing a node in the dashboard

**Files:**
- Modify: `src/web/nodes.ts`, `src/web/api.ts`, `src/web/components/NewTaskDialog.tsx`, `src/web/components/EnvBadge.tsx`, `src/web/components/Worktrees.tsx`, `src/web/pages/CheckoutPage.tsx`, `src/web/pages/ProjectReview.tsx`, `src/web/pages/NodesPage.tsx`
- Test: `test/web/nodes.test.ts`

**Interfaces:**
- Consumes: `NodeView` (Plan 1), `EnvironmentView.node`, `Worktree.node`, `TaskRequest.node` (Task 2), `POST review/bring-home` (Task 9).
- Produces:

```ts
// src/web/nodes.ts
export function nodeChoices(nodes: NodeView[] | undefined): ChoiceOption[];
export function envNode(nodeId: string | undefined, nodes: NodeView[] | undefined): { label: string; offline: boolean } | undefined;
// src/web/api.ts
export function bringHome(projectId: string, directory: string): Promise<{ branch: string }>;
```

- [ ] **Step 1: Write the failing tests**

Add to `test/web/nodes.test.ts` (extend the import with `envNode, nodeChoices`):

```ts
describe("task form nodes", () => {
  const nodes = [
    { id: "local", label: "This machine", state: "online" as const, stats: { cpus: 8, memTotal: 32 * GiB, memAvailable: 12.5 * GiB, containers: 3 } },
    { id: "box", label: "Workstation", ssh: "tim@box", state: "online" as const },
    { id: "pi", label: "pi", ssh: "pi", state: "unreachable" as const },
  ];

  it("offers every node, with free memory or why it can't be used", () => {
    expect(nodeChoices(nodes)).toEqual([
      { value: "local", label: "This machine · 12.5 GiB free" },
      { value: "box", label: "Workstation" },
      { value: "pi", label: "pi · unreachable" },
    ]);
    expect(nodeChoices(undefined)).toEqual([]);
  });

  it("names a remote environment's node and whether it's offline", () => {
    expect(envNode(undefined, nodes)).toBeUndefined();
    expect(envNode("local", nodes)).toBeUndefined();
    expect(envNode("box", nodes)).toEqual({ label: "Workstation", offline: false });
    expect(envNode("pi", nodes)).toEqual({ label: "pi", offline: true });
    expect(envNode("gone", nodes)).toEqual({ label: "gone", offline: true });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run test/web/nodes.test.ts`
Expected: FAIL, because `nodeChoices` and `envNode` don't exist.

- [ ] **Step 3: Implement the helpers and API call**

In `src/web/nodes.ts`, add `import type { ChoiceOption } from "./components/Choice";` and:

```ts
/** The task form's Node options, in the snapshot's order (this machine first). */
export function nodeChoices(nodes: NodeView[] | undefined): ChoiceOption[] {
  return (nodes ?? []).map((n) => {
    const extra =
      n.state !== "online" ? ` · ${nodeStateLabel(n.state).toLowerCase()}` : n.stats ? ` · ${formatMemory(n.stats.memAvailable)} free` : "";
    return { value: n.id, label: `${n.label}${extra}` };
  });
}

/** The node a remote environment runs on, and whether it's reachable right now; undefined for this machine. */
export function envNode(nodeId: string | undefined, nodes: NodeView[] | undefined): { label: string; offline: boolean } | undefined {
  if (!nodeId || nodeId === "local") return undefined;
  const node = nodes?.find((n) => n.id === nodeId);
  return { label: node?.label ?? nodeId, offline: node?.state !== "online" };
}
```

In `src/web/api.ts`, after `mergeIntoBase`:

```ts
export function bringHome(projectId: string, directory: string): Promise<{ branch: string }> {
  return postJson(projectId, "review/bring-home", { directory }, "bring home");
}
```

Run: `pnpm vitest run test/web/nodes.test.ts`
Expected: PASS.

- [ ] **Step 4: Wire the UI**

`src/web/components/NewTaskDialog.tsx`:
- Import `nodeChoices` from `../nodes`.
- Add the state `const [node, setNode] = useState("local");`. Reset it to `"local"` in the project select's `onChange`, next to `setEnvironment(undefined)`.
- After `const view = …`, compute:

```ts
  const nodes = snapshot?.nodes ?? [];
  const remote = node !== "local";
```

- Change `effectiveWhere` to `const effectiveWhere: TaskWhere = remote ? "worktree" : worktreesReady ? where : "workspace";`. Change `chosenEnv` to `const chosenEnv: Isolation = remote ? "isolated" : isolation?.unsupported ? "shared" : (environment ?? isolation?.default ?? "shared");`.
- In `submit`, add `...(remote ? { node } : {}),` after the `environment` spread.
- Before the "Where" row, render the Node row only when `nodes.length > 1`:

```tsx
          {nodes.length > 1 && (
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <Label htmlFor="task-node" className="font-normal text-muted-foreground">
                Node
              </Label>
              <Choice id="task-node" value={node} options={nodeChoices(nodes)} onChange={setNode} />
              {remote && (
                <span className="text-muted-foreground">
                  {isolation?.unsupported ?? "Runs in a new worktree with its own container, from the base pushed to that node."}
                </span>
              )}
            </div>
          )}
```

- Disable both "Where" radio items when `remote` (`disabled={remote || …}` on `worktree`; `disabled={remote}` on `workspace`), and both "Environment" items the same way.

`src/web/components/EnvBadge.tsx`:

```tsx
import type { EnvironmentView } from "../../shared/types";
import { Badge } from "@/components/ui/badge";
import { useDash } from "../DashboardContext";
import { envTone } from "../derive";
import { envNode } from "../nodes";
import { STATE_LABEL, StatusDot } from "./Status";

/** A worktree's own container: a dot and its state, and its node when that's another machine. */
export function EnvBadge({ env }: { env: EnvironmentView }) {
  const { snapshot } = useDash();
  const { containerState, opencode, error } = env.runtime;
  const node = envNode(env.node, snapshot?.nodes);
  const label = node?.offline ? "offline" : containerState === "running" && opencode === "unhealthy" ? "opencode down" : STATE_LABEL[containerState];
  const where = node ? `On ${node.label}` : "Own container";
  return (
    <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground" title={error ?? `${where} (${env.id})`}>
      <StatusDot tone={node?.offline ? "off" : envTone(env)} label={label} /> {where} · {label}
    </Badge>
  );
}
```

`src/web/components/Worktrees.tsx`, in `removeContainer`:

```ts
  const removeContainer = (env: EnvironmentView, label: string) => {
    const text = env.node
      ? `Remove ${label} from ${env.node}? Its container, worktree and branch there are deleted; bring the branch home first to keep its commits.`
      : `Remove the container of ${label}? Its sessions are deleted; the worktree and its files stay.`;
    if (!confirm(text)) return;
    busy(`env:${env.id}`, () => removeEnv(view.project.id, env.id));
  };
```

`src/web/pages/CheckoutPage.tsx`: render `<OpenInMenu … />` only when `!checkout.worktree?.node`.

`src/web/pages/ProjectReview.tsx`:
- Import `bringHome` from `../api` and `DownloadIcon` from `lucide-react`.
- Find the checkout's worktree: `const remoteNode = view.runtime.worktrees?.find((w) => w.path === directory)?.node;`.
- Add the action next to `update`:

```ts
  const fetchHome = () =>
    run("Bringing home", async () => {
      const { branch } = await bringHome(projectId, directory);
      setNotice(`Fetched ${branch} from ${remoteNode} into this machine's repository.`);
      load();
    });
```

- In the Git menu, after the merge item:

```tsx
              {remoteNode && (
                <GitItem icon={<DownloadIcon />} label={`Bring home from ${remoteNode}`} blocker={data ? undefined : "Loading…"} onSelect={fetchHome} />
              )}
```

`src/web/pages/NodesPage.tsx`: the page description becomes "Machines that run task environments, reached over ssh. Choose one in the New task form."

- [ ] **Step 5: Typecheck, test, build, and check in the browser**

Run: `pnpm typecheck && pnpm vitest run test/web && pnpm build`
Expected: PASS, and the build succeeds.

Start an isolated instance on the fresh build, with temporary `XDG_CONFIG_HOME` and `XDG_STATE_HOME`, an empty `--root`, and a free port such as 7790. Add a node (`nosuchhost.invalid`). Open the New task dialog from the command palette or the shortcut, and check:
- The Node select lists "This machine · … free" and "nosuchhost.invalid · unreachable".
- Choosing it disables Where and Environment and shows the note.

Stop the instance and remove the node.

- [ ] **Step 6: Commit**

```bash
git add src/web test/web/nodes.test.ts
git commit -m "feat(web): choose a node for a task, see where environments run, bring branches home"
```

---

### Task 12: Docs and full verification

**Files:**
- Modify: `../../README.md`

- [ ] **Step 1: Update the README**

Replace the body of "## Remote nodes (preview)" with:

```markdown
## Remote nodes (preview)

Other machines can run task environments, reached over ssh. Add one on the Nodes page, or with
`opendevhub nodes add tim@workstation --label Workstation` (then restart opendevhub). The Nodes
page shows whether each node is reachable and ready, and how much CPU and memory it has free.

To run a task there, pick the node in the New task form. It gets a new worktree with its own
container on that node: opendevhub pushes the base branch (the one you choose, or the main
checkout's current branch) into a repository it keeps under `~/.opendevhub/repos` on the node,
creates the worktree there, and starts the container with the node's Docker. Uncommitted changes
in your main checkout stay behind.

Sessions, permissions, forwarded ports, review, commit and Update from base work as for local
tasks. **Bring home** (in the review's Git menu) fetches the branch into this machine's repository;
Merge into base and Publish do that first. Removing the task deletes its worktree and branch on the
node, so bring the branch home first to keep its commits. Checks and Open in editor aren't
available for tasks on other nodes yet.

A node needs:

- Docker, the devcontainer CLI and git 2.48 or newer, on the PATH of a **non-interactive** ssh
  shell. Tools installed through nvm or a login profile often aren't: check with
  `ssh tim@workstation 'devcontainer --version'`, and if it fails, link the binary into
  `/usr/local/bin` or set PATH in `~/.ssh/environment` (with `PermitUserEnvironment yes`).
- An ssh key that logs in without a prompt, and a known host key: run `ssh tim@workstation` once.
- `AllowTcpForwarding yes` in its sshd config (the default).
- A Linux Docker engine: containers are reached at their IP from the node itself.

opendevhub keeps one ssh connection per node (a ControlMaster under
`~/.config/opendevhub/ssh/`) and reconnects by itself when a node drops. Meanwhile its tasks show
as offline. Containers keep running there and are picked up again when the node is back. Nothing is
installed on the node and nothing listens there besides sshd.
```

- [ ] **Step 2: Full verification**

Run: `pnpm typecheck && pnpm test && pnpm build`
Expected: everything passes, and the build succeeds.

If `ssh -o BatchMode=yes localhost true` works on this machine, also run
`ODH_TEST_SSH_LOCALHOST=1 pnpm vitest run test/server/ssh-localhost.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add ../../README.md
git commit -m "docs: running tasks on remote nodes"
```
