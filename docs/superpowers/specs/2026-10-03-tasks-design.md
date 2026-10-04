# Tasks: start work with a prompt

Date: 2026-10-03
Status: Draft for review
Depends on: nothing. The variant comparison page shows diff stats once
[review](2026-10-03-review-design.md) has shipped.

## Problem

The dashboard can create a worktree and an empty session, but you still have to switch to the
opencode tab to say what the agent should do. There's also no way to run the same prompt on
several models and compare the results.

A **task** is one prompt, run in one or more sessions ("variants"). Each variant usually runs
in its own worktree.

## Verified opencode facts (2.0.22)

| Need | Endpoint | Notes |
| --- | --- | --- |
| Create a session | `POST /api/session` | Also takes `model: { id, providerID, variant? }`, `agent`, `metadata`, `permissions[]`. |
| Send a prompt | `POST /api/session/:sid/prompt` | `{ text, delivery?: "steer" \| "queue", resume? }`. Asynchronous: it stores the input and schedules the agent loop. |
| Models and agents | `GET /api/model`, `GET /api/model/default`, `GET /api/agent` | Per directory. |
| Session cost | `Session.Info` | `cost` (USD), `tokens`, `outcome`, `time.idle`, `metadata`, `model`, `agent`. |

`PATCH /api/session/:sid` accepts `title`, `metadata` and `permissions`, but not `archived`.

## Where task identity lives

In opencode, not in opendevhub's state. Sessions are created with:

```json
{ "metadata": { "opendevhub": { "task": "tsk_<ulid>", "variant": 1, "of": 3, "title": "…" } } }
```

A task therefore survives opendevhub restarts and container rebuilds, just as sessions do.

- `RawSession` adds `metadata`, `model`, `cost`, `tokens` and `outcome`.
- `SessionSummary` adds `task?`, `model?` and `cost?`.
- Discarding a variant patches its metadata with `{ discarded: true }`, which hides it. (PATCH
  can't archive a session.)

## API

`POST /api/projects/:id/tasks`

```ts
{
  prompt: string;                 // required
  title?: string;                 // default: first line of the prompt, ≤ 60 chars
  where: "worktree" | "workspace"; // default "worktree"
  branch?: string;                // default: slug of the title; "-2", "-3"… if taken
  base?: string;                  // default: the workspace's current branch
  variants: { model?: ModelRef; agent?: string }[]; // 1–4; [{}] = the defaults
}
→ { task: string; variants: { branch?: string; directory: string; sessionId?: string; error?: string }[] }
```

For each variant, in order and under one git lock for the project:

1. When `where` is `"worktree"`, create the worktree through the existing `createWorktree`
   path. With several variants, the branch is `<branch>-<model short name>`, or `<branch>-<n>`
   when models repeat.
2. Call `createSession(directory, { title, model, agent, metadata })`.
3. Call `prompt(sessionId, { text })`.

Today `withGit` throws `BusyError` on a second concurrent call, so the variants run inside one
held lock rather than taking it once each.

A failure in one variant is recorded on that variant, and the rest still run. Worktrees that
were created are kept: they're cheap, visible, and the Worktrees tab can remove them.

**Supporting routes:**

- `GET /api/projects/:id/models` → `{ models, default, agents }`, proxied from opencode and
  cached for 60 s per project.
- `POST /api/projects/:id/sessions/:sid/prompt` with `{ text, delivery? }`: a general "send to
  agent" route. The review spec uses it too; whichever ships first adds it.
- The existing `POST /api/projects/:id/worktrees` with `startSession` gains an optional `prompt`.

## UI

**New task dialog.** Opened from a button on the Overview and project pages, from
`⌘K → New task`, or with `n` on any page. Fields:

- Project: preselected on a project page
- Prompt: multiline; `⌘Enter` submits
- Title, branch, base: folded under "Options", with live previews of the derived values
- Where: "New worktree" (default) or "Main checkout"
- Variants: a model picker; "+ Compare with another model" adds a row, up to 4

The dialog needs the project running and offers **Start project** when it isn't. On submit,
the dashboard goes to the session, or to the task page when there are several variants. It
does not open the opencode tab.

**Task page** (`/p/:id/t/:task`), for tasks with several variants. One column per variant shows
status, model, cost and tokens, plus diff stats (files, +/−) and a **Review** link once review
has shipped. **Pick this one** marks the other variants discarded and offers to remove their
worktrees and delete their branches. That removal needs a confirmation, which lists any
uncommitted changes.

**Session rows** show a task chip and, when there are several variants, the model.

## Not covered

File or image attachments in the prompt, prompt templates, scheduled tasks, and tasks created
from issues (that needs forge APIs; see the publish spec's "later" list).

## Delivery

1. A single variant, plus `prompt` on worktree creation.
2. Several variants and the task page.

## Testing

- **Unit:** branch, slug and variant naming; title derivation.
- **Integration** (fake opencode): task creation where one variant fails; metadata written on
  every session.
- **e2e:** create a task with `variants: [{}]` without an LLM, then check the session, its
  metadata and the worktree exist. The prompt is accepted asynchronously, so no model is
  needed.
