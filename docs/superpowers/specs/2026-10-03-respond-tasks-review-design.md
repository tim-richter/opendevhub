# Respond, tasks and review — closing the loop

Date: 2026-10-03
Status: Draft for review

## Problem

The dashboard tells you an agent needs you, then sends you to another tab. It can't start work
with a prompt, and it has nothing for the part after the agent finishes: looking at the change,
sending feedback, and getting the branch merged or into a pull request. Comparable tools
(Conductor, Vibe Kanban, Nimbalyst, Sculptor) all do this inside the orchestrator.

This spec adds three features, shipped in this order:

1. **Respond inline**: answer permission requests and questions from the dashboard.
2. **Tasks**: start work with a prompt, optionally as N variants on different models.
3. **Review**: a diff of each worktree against its base, line comments sent back to the agent,
   then commit, update from base, merge locally, or publish to a forge. Publishing does not
   depend on any forge's CLI. Forgejo gets native support.

The opencode web UI stays the place for chatting with an agent. The dashboard handles the
short interactions: approve, answer, kick off, review, ship.

## Verified opencode facts (2.0.22)

From `GET /openapi.json` on `opencode serve` 2.0.22 and live calls against it:

| Need | Endpoint | Notes |
| --- | --- | --- |
| Pending permissions | `GET /api/permission/request` | Items: `{ id, sessionID, action, resources[], save?[], message?, metadata?, source? }`. Listed per directory, as the monitor already does. |
| Reply to a permission | `POST /api/session/:sid/permission/:rid/reply` | `{ decision: "once" \| "always" \| "reject", message?: string }` |
| Pending forms | `GET /api/form` | `{ id, sessionID, title, fields[] }`. Field types: `string` (with optional `options`, `custom`, `format`, `pattern`), `number`, `integer`, `boolean`, `multiselect`, `external` (`url`). Every field may have `required`, `hidden` and `when: [{ key, op: eq\|neq, value }]`. |
| Answer a form | `POST /api/session/:sid/form/:fid/reply` | `{ answer: { [key]: string \| number \| boolean \| string[] } }` |
| Cancel a form | `DELETE /api/session/:sid/form/:fid?message=` | The asker is told why. |
| Create a session | `POST /api/session` | Also takes `model: { id, providerID, variant? }`, `agent`, `metadata`, `permissions[]`. |
| Send a prompt | `POST /api/session/:sid/prompt` | `{ text, delivery?: "steer" \| "queue", resume? }`. Asynchronous: it stores the input and schedules the agent loop. |
| Models and agents | `GET /api/model`, `GET /api/model/default`, `GET /api/agent` | Per directory. |
| Review diff | `GET /api/vcs/diff?mode=working\|branch\|committed&base=` | `[{ file, patch, additions, deletions, status }]`. `branch` = merge-base(base) → working copy, untracked files included. |
| Base and branch | `GET /api/vcs`, `GET /api/vcs/base` | `/api/vcs` → `{ branch: { current, default } }`. `/api/vcs/base` answers 503 "Choose a review base" when history is ambiguous; it did so on a plain `git checkout -b`. |
| Text from session context | `POST /api/session/:sid/generate` | `{ prompt }` → `{ text }` without changing the history. Used for commit messages and PR text. |
| Session cost | `Session.Info` | `cost` (USD), `tokens`, `outcome`, `time.idle`, `metadata`, `model`, `agent`. |
| Test fixtures | `POST /api/session/:sid/permission`, `POST /api/session/:sid/form` | Create real pending items without an LLM, so e2e can cover feature 1. |

`PATCH /api/session/:sid` accepts `title`, `metadata` and `permissions`, but not `archived`.

---

## 1. Respond inline

### Data

The monitor already fetches permission requests and forms, then reduces them to a status. Keep
the items and attach them to the root session that the status rolls up to:

```ts
interface PendingPermission {
  id: string;
  sessionId: string;        // the session that asked (may be a subagent); used in the reply path
  action: string;           // e.g. "bash", "edit", "webfetch"
  resources: string[];
  save?: string[];          // patterns "always" would persist
  message?: string;
  createdAt?: number;       // first time the monitor saw it; for ordering
}

interface PendingForm {
  id: string;
  sessionId: string;
  title: string;
  fields: FormField[];      // the opencode schema, passed through unchanged
}

interface SessionSummary {
  // …existing
  pending?: { permissions: PendingPermission[]; forms: PendingForm[] };
}
```

`deriveSessions` already maps each item to its root. It now also collects the items. Snapshots
stay small: there are rarely more than a handful pending at once.

### API

| Route | Body | Calls |
| --- | --- | --- |
| `POST /api/projects/:id/permissions/:rid` | `{ decision, message? }` | `…/permission/:rid/reply` |
| `POST /api/projects/:id/forms/:fid` | `{ answer }` | `…/form/:fid/reply` |
| `DELETE /api/projects/:id/forms/:fid` | `{ message? }` | `DELETE …/form/:fid` |

- The server looks up `rid`/`fid` in the project's latest snapshot to find `sessionId`. Unknown
  ids get a 404, so the dashboard never forwards ids it didn't list itself.
- When opencode answers 404 (`PermissionNotFound`, `FormNotFound`) or `FormAlreadySettled`, the
  item was handled elsewhere, for example in the opencode tab. Respond with 409
  `already answered`; the UI drops the card without showing an error.
- `FormInvalidAnswer` → 400 with opencode's message, shown under the form.
- After every reply, `monitor.reconcile()` so the snapshot updates without waiting for the SSE
  event.
- No new security checks are needed beyond the existing Origin check. Agent-supplied text
  (`message`, `resources`, form titles) is rendered as plain text and never as HTML or Markdown.

### UI

Rows in "Needs you" (Overview, the project's Sessions tab, `/sessions`) expand into cards:

- **Permission card**: "*session title* wants to **action**", the resources in monospace (first
  5, then "+n more"), and the message. Buttons:
  - **Allow once**
  - **Always allow**: its tooltip lists the `save` patterns, so you know what gets persisted
  - **Reject…**: opens an optional reason field; the reason goes back to the agent as `message`

  If `metadata` contains a string `diff` or `patch` (likely for `edit`; not verified), render it
  with the review diff component.
- **Form card**: renders the fields:

  | Field | Control |
  | --- | --- |
  | `string` with `options` | radios (≤ 5 options) or a select; plus a text input when `custom` |
  | `string` | text input, with HTML validation from `format`, `pattern`, `min/maxLength` |
  | `number` / `integer` | number input |
  | `boolean` | checkbox |
  | `multiselect` | checkboxes, honouring `minItems`/`maxItems` and `custom` |
  | `external` | "Open" link to `url` |

  `when` and `hidden` are evaluated on the client. Buttons: **Submit** and **Dismiss** (cancel
  with an optional message). If a field type isn't in the table, show the fields read-only and
  link to "Answer in opencode".
- Several pending items in one session stack oldest first. Answering one shows the next.
- Keyboard, while a card has focus: `Enter` allow once, `a` always, `r` reject, `j`/`k` move
  between cards.
- Notification text includes what is being asked ("api · wants **bash**: `npm test`").
  Clicking a notification already opens the session's row; now it also focuses the card.

### Not covered

- Approving from the notification itself. That needs a service worker and Web Push, which
  belongs with the remote access work.
- Bulk "allow all".

---

## 2. Tasks

A **task** is one prompt, run in one or more sessions ("variants"). Each variant usually runs
in its own worktree.

### Where task identity lives

In opencode, not in opendevhub's state. Sessions are created with

```json
{ "metadata": { "opendevhub": { "task": "tsk_<ulid>", "variant": 1, "of": 3, "title": "…", "base": "main" } } }
```

so a task survives opendevhub restarts and container rebuilds, the same way sessions do.
`RawSession` adds `metadata`, `model`, `cost`, `tokens` and `outcome`. `SessionSummary` adds
`task?`, `model?` and `cost?`.

Discarding a variant does `PATCH` on the metadata with `{ discarded: true }`, which hides it.
The PATCH endpoint can't archive.

### API

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

For each variant, in order and under a single git lock for the project (unlike today's
`withGit`, which throws `BusyError` on the second call):

1. When `where` is `"worktree"`, create the worktree. With several variants, the branch is
   `<branch>-<model short name>`, or `<branch>-<n>` when models repeat.
2. Call `createSession(directory, { title, model, agent, metadata })`.
3. Call `prompt(sessionId, { text })`.

A failure in one variant is recorded on that variant, and the remaining variants still run.
Worktrees that were created are kept: they're cheap, visible, and the Worktrees tab can remove
them. The base branch is also written to `git config branch.<branch>.opendevhubBase <base>`,
so review (§3) knows what to diff against, on both sides and across restarts.

Supporting routes:

- `GET /api/projects/:id/models` → `{ models, default, agents }`, proxied from opencode, cached
  60 s per project.
- The existing `POST /api/projects/:id/worktrees` with `startSession` gains an optional `prompt`.
- `POST /api/projects/:id/sessions/:sid/prompt` with `{ text, delivery? }` is the general
  "send to agent" endpoint. Review uses it too.

### UI

- **New task** dialog: from a button on the Overview and project pages, from `⌘K → New task`,
  and with `n` on any page. Fields:
  - Project: preselected on a project page
  - Prompt: multiline; `⌘Enter` submits
  - Title, branch, base: folded under "Options", with live previews of the derived values
  - Where: "New worktree" (default) or "Main checkout"
  - Variants: a model picker; "+ Compare with another model" adds a row, up to 4

  The dialog requires the project to be running and offers **Start project** when it isn't.
  On submit, the dashboard navigates to the session, or to the task page when there are several
  variants. It does not open the opencode tab.
- **Task page** (`/p/:id/t/:task`), for multi-variant tasks: one column per variant with status,
  model, cost, tokens and diff stats (files, +/−) taken from §3. Each column has **Review**
  (opens §3) and **Pick this one**. Picking marks the other variants discarded and offers to
  remove their worktrees and delete their branches. Removing them needs a confirmation, which
  lists any uncommitted changes.
- Session rows show a task chip and, when there are variants, the model.

### Not covered

File or image attachments in the prompt. Prompt templates. Scheduled tasks. Tasks created from
issues (that needs forge APIs, see §3.6).

---

## 3. Review

Review works on one **target**: a worktree, or the main checkout. It answers "what did the
agent change?", lets you send line comments back, and then gets the change somewhere.

### 3.1 Diff

`GET /api/projects/:id/review?directory=<dir>`

```ts
{
  directory: string;
  branch?: string;               // undefined on a detached HEAD
  base?: { name: string; source: "config" | "opencode" | "default" };
  ahead: number; behind: number; // `git rev-list --left-right --count base...HEAD`
  dirty: boolean;                // uncommitted changes, from /api/vcs/status
  files: { file; status; additions; deletions; patch }[];
  truncated?: boolean;
}
```

- The base is resolved in this order: `branch.<b>.opendevhubBase` → `/api/vcs/base` → the
  default from `/api/vcs`. The UI can override it, and `?base=` overrides it per request.
- The diff comes from `/api/vcs/diff?mode=branch&base=<base>` for worktrees, and `mode=working`
  for the main checkout when it is on the base branch. That's everything the agent did,
  committed or not, including untracked files.
- The response is capped at 2 MB of patches. Larger files are listed with their stats only, and
  their patch is loaded on demand with `?file=`.
- Every path is checked with `checkDirectory`. Refresh triggers: the target's sessions going idle
  (from the monitor), any git action in §3.3, and the manual refresh button.

UI: a **Review** tab on the project page (`/p/:id/review/:target?`), plus links from worktree
rows, session rows and the task page. On the left, a file list with status and +/−. On the
right, a unified diff with line numbers. Files over 400 changed lines start collapsed, and
binary files show "binary". The header shows the target, base and ahead/behind, with a base
picker. Version one has no syntax highlighting.

### 3.2 Comments → agent

- Clicking a line number opens a comment box anchored to `file:line`: the new-side line, or the
  old-side line for deletions. A general comment box sits at the top.
- Draft comments live in `localStorage`, keyed by project, target and base, so a reload doesn't
  lose them.
- **Send to agent (n)** writes one prompt and posts it to the target's most recent session, or
  to a session you pick, or to a new one. It uses `delivery: "queue"` when that session is
  running. The prompt:

  ```
  Review feedback on <branch> (compared with <base>). Address each point, then reply with what you changed.

  1. src/auth.ts:42
     > +  if (token == null) return next();
     This skips auth for missing tokens; it should 401.

  2. General: please add a test for the redirect.
  ```

  The quoted lines are the commented line plus up to 2 lines before it, taken from the patch.
  Sent comments are cleared and appended to a per-target "sent" list for reference.

### 3.3 Git actions

All of these run in the container, under the project's git lock, against `directory` only,
with the base given as a ref. That way hooks see the container's toolchain, and the identity
is the same one the agent commits with.

| Action | Enabled when | Does |
| --- | --- | --- |
| **Commit** | `dirty` | `git add -A && git commit -m <msg>`. The message field is prefilled from `generate` on the target's session ("Write a conventional commit message for the uncommitted changes"). It stays editable and falls back to empty. |
| **Update from base** | `behind > 0` | `git rebase <base>` when the branch has never been published, otherwise `git merge <base>`. On a conflict: `--abort`, report the conflicting files, and offer **Ask agent to resolve**, which sends a prompt to rebase or merge and resolve. The repo is never left mid-rebase. |
| **Merge into base** | `ahead > 0`, `!dirty`, and the main checkout is clean and on `<base>` | `git -C <workspace> merge --no-ff <branch>`, or `--ff-only` if you choose. Afterwards it offers to remove the worktree and delete the branch. This is the no-forge path for solo work. |
| **Publish** | `ahead > 0`, `!dirty` | §3.4 |

A missing commit identity in the container (`user.name`/`user.email`) produces an error that
names the cause, with a hint: set it in the devcontainer, or use `git config --global` in
`postCreateCommand`.

### 3.4 Publish, without depending on a forge

Publishing has two parts: **push** (git) and **open the PR** (forge-specific, and usually just
a URL).

**Where the push runs.** On the host, by default, when the checkout works there: the main
checkout always does, and worktrees do when they have a `hostPath` with relative links. On the
host, the user's own ssh-agent, credential helper and `~/.ssh/config` aliases apply, so
containers never need push credentials. Otherwise the push runs in the container.
`OPENDEVHUB_PUSH=host|container` forces one or the other. One caveat: `pre-push` hooks then run
on the host. The push is never run with `--no-verify`.

**Forge detection.** `git remote get-url <remote>` (default `origin`) is parsed into
`{ host, owner/repo path, webBase }`, covering scp-style, `ssh://` (with a port) and `https`
URLs. The forge kind:

1. `forges` in `config.json` (`{ "git.example.com": { "kind": "forgejo", "web": "https://git.example.com" } }`),
   which also maps ssh host aliases to web hosts
2. Well-known hosts: `github.com`, `gitlab.com`, `codeberg.org` (Forgejo), `bitbucket.org`
3. A one-time unauthenticated probe of `https://<host>/api/forgejo/v1/version`, then
   `/api/v1/version` (Gitea), cached in `config.json`
4. Otherwise `unknown`

**Strategies:**

| Kind | Default | What happens |
| --- | --- | --- |
| `forgejo` / `gitea` | `agit` | `git push <remote> HEAD:refs/for/<base> -o topic=<branch> -o title=<title> -o description=<desc>`. The pull request is created by the push itself: no API token, no fork, no server-side branch. Re-publishing uses the same topic, with `-o force-push=true` after a rebase. |
| `forgejo` / `gitea` | `branch` (opt-in) | Push the branch, then open `<web>/compare/<base>...<branch>`. Gitea and Forgejo don't prefill the title or body from query parameters, so you type them on the forge. |
| `github` | `branch` | Push, then open `<web>/compare/<base>...<branch>?quick_pull=1&title=…&body=…` (body truncated to keep the URL under 8 KB). No `gh`, no token. |
| `gitlab` | `branch` | Push, then open `<web>/-/merge_requests/new?merge_request[source_branch]=…&merge_request[target_branch]=…&merge_request[title]=…&merge_request[description]=…` (prefill parameters not verified). |
| `bitbucket` | `branch` | Push, then open `<web>/pull-requests/new?source=<branch>&dest=<base>`. |
| `unknown` | `branch` | Push only. Any URL the remote prints is shown as a link. |

For every kind, the push output is scanned for `remote:` lines that contain an `https://` URL.
Forgejo, Gitea, GitLab and GitHub all print the new or existing PR/MR URL there, so this is the
generic way to get the link. The first matching URL is stored in
`branch.<b>.opendevhubPr` (and the AGit topic in `branch.<b>.opendevhubTopic`), and the Review
header then shows **View PR** and **Update PR**.

**Title and description.** These are prefilled with `generate` on the target's session ("Write
a pull request title and a short description of this branch's changes"), and you can edit them
in the Publish dialog. The dialog also has: the remote (default `origin`), the target base, and
the strategy, prefilled from the detected kind.

AGit details to settle during implementation:

- Push options can't contain newlines. Forgejo accepts multi-line descriptions encoded as
  base64 (forgejo#8479). Confirm the exact encoding against a Forgejo instance. Until then,
  send a one-line description and put the full text in the commit message body.
- The PR's head is `refs/pull/<n>/head`, not a branch. Forgejo Actions `pull_request` workflows
  should still run; confirm this in the Forgejo e2e test.
- A base branch containing `/` in `refs/for/<base>` should work because the topic is passed
  with `-o topic`; this needs a test.
- Once the PR is merged or closed, re-publishing with the same topic opens a new PR. In that
  case the dashboard clears the stored topic and URL and says so.

### 3.5 Errors

Every git and push failure surfaces as the existing `CommandError` (the last 5 lines of output),
on the Review tab and in the project log. A rejected push (non-fast-forward) offers **Update
from base**. Any force push is always `--force-with-lease` (branch strategy) or
`force-push=true` (AGit), and only after a rebase that opendevhub itself performed.

### 3.6 Not covered (later)

- **Forge APIs with tokens**: PR status, CI checks and review comments shown in the dashboard,
  and tasks created from issues. Forgejo first, using `/api/v1/repos/{o}/{r}/pulls`, with the
  token kept in the host's keychain or an env var. Nothing in this spec stores credentials.
- GitLab `merge_request.*` push options, which would do for GitLab what AGit does for Forgejo.
- Syntax highlighting and a side-by-side diff.
- Review of an existing PR from the forge.

---

## Delivery plan

| Phase | Scope | Rough size |
| --- | --- | --- |
| A | §1 complete | small: types, 3 routes, 2 card components |
| B | §2 with a single variant, plus `prompt` on worktree create | small |
| C | §3.1 diff and §3.2 comments → agent | medium |
| D | §3.3 git actions | medium |
| E | §3.4 publish (branch strategy for all kinds, then Forgejo AGit) | medium |
| F | §2 variants and the task page | small, once C exists |

Each phase stands on its own and is useful by itself. A–C deliver most of the value.

## Testing

- **Unit**:
  - `deriveSessions` with pending items rolling up to roots
  - form `when`/`hidden` evaluation and answer building
  - branch/slug/variant naming
  - base resolution order
  - the review prompt composer
  - remote URL parsing (a table of scp, ssh-with-port, https and alias forms)
  - forge detection
  - compare-URL builders
  - the AGit command builder
  - parsing push output for URLs
- **Integration** (fake opencode, as in the existing tests): the reply routes, including
  already-answered → 409; task creation with a partial variant failure; review route caps.
- **e2e** (real container and opencode): create a permission and a form through opencode's own
  create endpoints, answer them through the dashboard API, and assert they're gone. Create a
  task with `variants: [{}]` without an LLM (assert the session, metadata and worktree exist;
  the prompt is accepted asynchronously). Commit, update and merge on a local repo. Publish to
  a bare repo as `unknown`.
- **Opt-in e2e, `OPENDEVHUB_E2E_FORGEJO=1`**: start a Forgejo container, create a repo, publish
  with AGit, and assert the PR exists through its API. Then re-publish after a rebase and assert
  there is still one PR.

## Open questions

1. Should the AGit default for Forgejo be changed to `branch` for users whose CI only runs on
   branch pushes?
2. Commit identity: should the container's git config win, or should opendevhub pass the host's
   `user.name`/`user.email` through `-c` on commits it makes?
3. Should **Merge into base** also push the base branch, or leave that to you?
