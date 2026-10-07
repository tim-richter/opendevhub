# Add project: bootstrap repos without a devcontainer

Date: 2026-10-05 Status: Draft for review Backlog item: "Bootstrap repos that have no devcontainer".

## Problem

Discovery only lists folders under the roots that have a `.devcontainer/devcontainer.json` or `.devcontainer.json`. Any other git repo is never shown, so to use opendevhub with it you have to write a devcontainer by hand, including installing opencode, and then rescan. For most repos this is the first hurdle.

## Scope

In:

- A **+** button next to the Projects heading in the sidebar, plus an "Add project…" entry in `⌘K`. Both open an **Add project** dialog.
- The dialog lists git repos under the configured roots that have no devcontainer.
- It detects the repo's stack, suggests a base image (which you can change), previews the generated `devcontainer.json`, then writes the file and starts the project.

Out: cloning from a URL, adding roots from the UI, committing the file, editing the generated JSON in the dialog, the egress firewall (its own backlog item), forwarded ports, and devcontainer features.

### Success criteria

- A git repo under a root with no devcontainer shows up in the dialog.
- Picking it and pressing **Add and start** writes `.devcontainer/devcontainer.json` (left uncommitted), the repo appears as a project, the dashboard goes to its page, and its container starts with opencode installed and reachable, with no further steps.
- The server writes only to repos that are candidates at the time of the request. The client sends a path and an image id, never file contents.

## Server

### Candidates (`discovery.ts`)

`scanCandidates(roots, maxDepth = 2): Promise<Candidate[]>` walks the tree like `scanRoots`: the same depth, skipping dotfolders, `node_modules` and `*.worktrees`. For each folder:

- If it has a devcontainer spec, it is a project. It is not a candidate and the walk does not go inside it.
- Otherwise, if it has `.git` (a folder or a file, so submodules and linked worktrees count), it is a candidate and the walk does not go inside it.
- Otherwise the walk goes inside it while the depth allows.

The walk shares one helper with `scanRoots`, so the skip rules can't drift apart. Results are sorted by name, then by path.

```ts
// src/shared/types.ts
interface Candidate {
  path: string; // absolute
  name: string; // basename
  root: string; // the root it was found under
  stack: StackId; // detected stack
}
```

### Templates (`templates.ts`)

```ts
type StackId = "node" | "python" | "go" | "rust" | "ruby" | "java" | "dotnet" | "php" | "generic";
const STACKS: Record<StackId, { label: string; image: string }>;
detectStack(dir: string): Promise<StackId>;
renderDevcontainer(name: string, stack: StackId): string;   // JSON text, 2-space indent, trailing newline
```

Detection checks marker files at the repo's top level, in this order. The first match wins:

| Marker | Stack | Image (`mcr.microsoft.com/devcontainers/…`) |
| --- | --- | --- |
| `package.json` | node | `javascript-node:22` |
| `pyproject.toml`, `requirements.txt`, `setup.py` | python | `python:3` |
| `go.mod` | go | `go:1` |
| `Cargo.toml` | rust | `rust:1` |
| `Gemfile` | ruby | `ruby:3` |
| `pom.xml`, `build.gradle`, `build.gradle.kts` | java | `java:21` |
| `*.csproj`, `*.sln` | dotnet | `dotnet:8.0` |
| `composer.json` | php | `php:8` |
| (none) | generic | `base:ubuntu` |

The generated file:

```json
{
  "name": "<repo name>",
  "image": "mcr.microsoft.com/devcontainers/<image>",
  "postCreateCommand": "curl -fsSL https://opencode.ai/install | bash"
}
```

The official installer runs on every image in the table (they all ship `curl` and `bash`). opendevhub already looks for the binary in `~/.opencode/bin`, so there is no npm dependency and the same command works for every stack.

### Routes (`dashboard-api.ts`)

- `GET /api/onboarding/candidates` returns `{ roots: string[], candidates: Candidate[], stacks: { id, label, image }[] }`. It scans the disk on each call; nothing is cached or kept in the store.
- `POST /api/onboarding` with `{ path: string, stack: StackId }`:
  1. `400` if `stack` is not a known `StackId`.
  2. Run `scanCandidates(roots)` again. `404` if `path` is not exactly one of the results. This keeps writes under a root, inside a git repo, and away from repos that already have a spec.
  3. Create `<path>/.devcontainer/` and write `devcontainer.json` with the `wx` flag, so an existing file is never overwritten (`409` if the write loses a race).
  4. `orchestrator.rescan()`, then find the new project by path. Start it the same way the start action does (fire and forget, honouring preflight errors). If preflight fails, the file stays written and the response says the project wasn't started.
  5. Answer `201 { projectId, started: boolean, error?: string }`.

The orchestrator takes no new state. All of this sits in a small `onboarding.ts` module (scan, validate, write) that the route calls, so it can be tested without HTTP.

## Web

- **Entry points.** `Shell.tsx`: a ghost icon button (`PlusIcon`, `size-5`) next to the project count in the Projects `SidebarGroupLabel`, with the tooltip "Add project". `CommandPalette`: an "Add project…" action. Both open the same dialog through `DashboardContext`, the same way `newTask` opens `NewTaskDialog`.
- **`AddProjectDialog.tsx`** (shadcn `Dialog`, `Command` for the list, `Select`):
  1. On open, `GET /api/onboarding/candidates`, showing skeleton rows while it loads. Each row shows the repo name and its path relative to its root, and the list can be filtered. If there are none: "No git repos without a devcontainer under" followed by the roots.
  2. Picking a row shows the detected stack (as "Detected: Node.js"), a stack `Select` set to the detected stack, and a read-only `<pre>` preview of the JSON. The preview is rendered on the client from the `stacks` list, using the same field layout as `renderDevcontainer`. To keep the two in sync, the template shape lives in `src/shared/` and both sides use it.
  3. **Add and start** posts the request, closes the dialog and navigates to `/p/<projectId>`, where the existing status, start progress and Logs tab take over. Errors (404, 409, network) appear inline in the dialog and keep it open. A `started: false` reply navigates anyway and shows a toast with the error.
- `src/web/api.ts`: `onboardingCandidates()` and `addProject(path, stack)`.

## Error handling

- A root that can't be read is skipped with the same warning `scanRoots` gives. Unreadable folders are skipped silently.
- A failed write (permissions, read-only filesystem) returns `500` with the OS error message, which the dialog shows.
- A failed container start shows up like any other: in the project's status and log. The generated file stays, so you can edit it and rebuild.

## Testing

- `test/server/discovery.test.ts`: `scanCandidates` on a temporary tree with a plain repo, a repo with a spec, a nested repo inside a project (not listed), a `.git` file, a `*.worktrees` folder, `node_modules`, and a repo below `maxDepth`.
- `test/server/templates.test.ts`: detection precedence (for example `package.json` plus `pyproject.toml` gives node), the generic fallback, and that rendering is valid JSON with the expected fields.
- `test/server/onboarding.test.ts` and the route in `dashboard-api.test.ts`: a path that is not a candidate gives 404 (including `..` tricks and a project path), an unknown stack gives 400, an existing file is not overwritten, and a successful call writes the file, rescans and starts the project (with a fake runner).
- e2e: create a bare `git init` repo under the e2e root, add it through the dialog, see the project page and the container reach running with opencode answering. The e2e image install goes through the opencode installer, so this test needs network access, like the existing fixture's `npm i`.
- README: the discovery bullet mentions **Add project**, and a short "Add project" section lists the stack table.
