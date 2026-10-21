## Context

Today every top-level session belongs to a task. Task variants own their sessions, and everything else gets a task of kind `manual`. That covers Chat's checkout target, checkout-page conversations, `/new`, text generation, and sessions adopted from opencode. `Chat.start` (`server/sessions/chat.ts`) creates a one-variant `task` for "New worktree" and a manual task otherwise. So the Tasks list mixes deliberate, opinionated work with throwaway conversations, and the `task-centric-navigation` change (2026-10-11) pushed the UI further toward "everything is a task".

This change makes the two entities explicit:

- **Chat**: a session in a checkout, controlled by the user, as in opencode.
- **Task**: owned by opendevhub. It has a brief, links, variants and the spec flow, and **each variant is a chat-like conversation**.

Relevant facts:

- The schema has a single migration (`server/db/migrations.ts`). Migrations run one per transaction, so `PRAGMA foreign_keys` can't be toggled inside one.
- `variants.session_id` is unique and is the only link between a session and a task.
- `OpencodeClient.generate(sessionId, prompt, dir)` produces text from a session's context without adding to its history. Commit and PR text already use it.
- The worktree → image → container → session setup pipeline lives inside `Tasks` and reports progress through the variant row.

## Goals / Non-Goals

**Goals:**

- A chat never creates a task, and the Tasks list contains only deliberate tasks (and drafts).
- A task wraps chats: one conversation view serves both a standalone chat and a variant's Conversation tab.
- Make task turns a worktree chat into a task without losing history, worktree or branch.
- Tasks can exist as drafts before any agent runs.
- Existing manual tasks survive as chats.

**Non-Goals:**

- Attaching an existing chat to an existing task as an extra variant. We'll revisit once Make task is in use.
- Making a task from a main-checkout chat. That would mean moving uncommitted changes into a new worktree.
- Turning a task back into a chat.
- Changing review tasks (kind `review`). They are already opendevhub-owned and stay tasks.
- Grouping several chats under one task in any way other than variants and same-directory threads.

## Decisions

### 1. A `chats` table, with its own id

New table, added in migration 2:

```
chats (
  id            TEXT PRIMARY KEY,          -- c_<ulid>, used in /chat/:project/:chat
  project_id    TEXT NOT NULL REFERENCES projects (id),
  session_id    TEXT UNIQUE,               -- null while a new worktree is set up
  env_id        TEXT REFERENCES environments (id),
  directory     TEXT,
  branch_id     INTEGER REFERENCES branches (id),
  worktree_id   INTEGER REFERENCES worktrees (id),
  origin        TEXT NOT NULL CHECK (origin IN ('hub', 'opencode', 'internal')),
  title         TEXT NOT NULL,
  step          TEXT NOT NULL,             -- same StartStep values as variants
  error         TEXT,
  created_at    INTEGER NOT NULL,
  session_removed_at INTEGER,
  archived_at   INTEGER,
  adopted_task  TEXT, adopted_variant INTEGER,
  FOREIGN KEY (adopted_task, adopted_variant) REFERENCES variants (task_id, n)
)
```

- **Own id, not the session id.** A new-worktree chat exists, and has a URL, before its session does. This is the same reason variants have rows before sessions.
- **Adopted rows are kept** (`adopted_task` set) so that `/chat/:project/:chat` can redirect to the task. They are excluded from every chat list. The invariant "a session is a variant's or a chat's" then reads: `chats.session_id` is set and `adopted_task` is null, or the session is a variant's.
- _Alternative considered_: keep manual tasks and only hide them in the UI. That is cheaper, but it keeps two meanings of "task" in the data and in every query (`kind != 'manual'` everywhere). It also leaves the bug class that caused the confusion.
- _Alternative considered_: one `sessions` table that both chats and variants reference. It's cleaner in theory, but it moves all of the variant's session columns and touches every task query. Not worth it now.

### 2. Shared checkout setup

Extract the setup pipeline from `Tasks` into a `CheckoutSetup` job: worktree, image, container, session, then the first message. It reports progress through a small sink interface. Variants write their steps to `variants`, and chats write them to `chats`. `Chat.start` for "New worktree" uses it directly, so no `Tasks` call is involved. Worktrees and branches made for a chat keep `created_by = 'manual'`. The created-by chip resolves "manual" to the chat by looking up `chats.worktree_id`.

### 3. Reconcile adopts into chats

`server/sessions/reconcile.ts` changes "adopt into a manual task" to "insert a chat with origin `opencode`". The same rule applies: skip directories where opendevhub is creating a session. That covers both variant and chat creation, so the existing "creating" guard extends to chats. Title sync and removal marking move from manual tasks to chats. Events: `chat.started`, `chat.discovered`, `chat.removed`, `chat.archived`, `chat.adopted`.

### 4. Make task = adopt, then optionally add variants

`POST /api/projects/:id/chats/:chat/task` takes `{ title, brief, ticket?, pullRequest?, spec: boolean, variants: TaskVariantSpec[] }`. In one transaction it:

1. checks that the chat is in a worktree, not adopted, not internal, and has a live session;
2. inserts the task (kind `task`, prompt = brief, links, `spec_first`);
3. inserts variant 1 with the chat's session, env, directory, branch, worktree, the latest turn's model and step `session`;
4. sets `chats.adopted_*`;
5. writes the `chat.adopted` event, plus `ticket.linked` and the PR link when given.

After commit, it sends `opsx-propose <brief>` to the session when `spec` is set, then calls `Tasks.addVariants` for the extra variants (decision 5). A double submit fails on step 1, or on the unique `variants_session` index.

The brief draft is `GET /api/projects/:id/chats/:chat/brief`, which calls `generate()` on the chat's own session with a fixed prompt: goal, decisions so far, open questions, constraints. Using the chat's own session (not an internal one) means the draft sees the full context and the transcript stays untouched. Ticket suggestions come from a `[A-Z][A-Z0-9]+-\d+` scan of the branch name and the transcript's user messages. PR suggestions come from the existing branch→PR link with role `head`.

### 5. `Tasks.addVariants(task, specs)`

`beginTask` is refactored into "insert task" and "add variants". Variant numbers continue after `MAX(n)`. `startTask` becomes insert + add. Starting a draft and Make task's extra variants both call `addVariants`. Extra variants from Make task use the chat branch's recorded `base` (falling back to the project's default branch) as their base.

### 6. Drafts are tasks with no variants

`taskState` returns `draft` for an empty variant list. The draft's requested variants (model, agent, node, where) are stored as JSON in a new `tasks.plan` column, so that Start can prefill the dialog. No new table is needed.

### 7. Leave the `kind` CHECK alone

Removing `manual` from `tasks.kind`'s CHECK means rebuilding `tasks` in SQLite. `variants`, `branches`, `reviews` and `events` reference it, and foreign keys can't be switched off inside the migration's transaction. The TypeScript `TaskKind` drops `manual`, the migration deletes all manual rows, and nothing writes the value again. A later table rebuild can tighten the CHECK if it ever matters.

### 8. Migration 2: manual tasks → chats

The migration runs in order:

1. Create `chats` and add `tasks.plan`.
2. `INSERT INTO chats … SELECT` from `tasks JOIN variants WHERE kind = 'manual'`. The id is `'c_' || task_id`, so ids stay unique and traceable. The origin is `opencode` when a `session.adopted` event exists for the session, and `hub` otherwise. The title, created_at, archived_at, session columns, env, directory, branch_id and worktree_id are copied.
3. `UPDATE branches SET created_by_task = NULL, created_by_variant = NULL` where they point at manual variants (they are `created_by = 'manual'` already).
4. Delete those variants, then those tasks.

Text-generation sessions that became manual tasks can't be told apart reliably after the fact. They migrate as `hub` chats, and the user can archive them. From now on they are created as `internal`.

### 9. Web structure

- `features/chat/`: the routes become `/chat/:project/:chat`. `chat-view.tsx` gets a header with Changes (a sheet or split pane reusing the review view) and Make task (`make-task-dialog.tsx`). `/chat/:project/<task id>` is told apart by prefix and redirects to the task.
- The conversation body is extracted from the Conversation tab into a shared `Conversation` component, used by both the chat view and the task tab.
- `shell/shell.tsx`: recent chats under the Chat entry, fed from the snapshot's chats sorted by last activity.
- `features/tasks/`: drop manual-kind branches; add the draft page (brief, links, plan, Start/Edit) and a "Save as draft" button in `new-task-dialog.tsx`.
- `features/projects/`: Drafts and Chats sections; Needs you merges chats and tasks.
- `features/checkouts/checkout-page.tsx`: the Tasks tab becomes Conversations (chats and tasks); "new conversation" starts a chat.

## Risks / Trade-offs

- **Users with many opencode sessions get a long chat list.** → The sidebar shows ten, the project page shows recent ones, archive hides chats, and "Show all" filters by project.
- **Adopted chat rows linger.** → They're small and are needed for redirects. They're excluded from lists by `adopted_task IS NULL`.
- **Shared setup extraction could regress task starts.** → Do it first, as its own step with the existing task-start tests green, before chats use it.
- **The brief draft costs a model call on every dialog open.** → Generate only once per dialog open, cancel when the dialog closes, and never block the confirm.
- **Spec option on a long chat**: `opsx-propose` runs with the whole conversation as context. That's the point, but it may hit context limits on very long chats. → Leave it to opencode's compaction. The dialog shows the chat's context usage next to the option.
- **This partly reverses `task-centric-navigation`.** → The task is still the single page for a task's work. What changes is only that not every conversation is a task. The memory note and the task-navigation spec are updated together.

## Migration Plan

1. Ship migration 2 together with the code. It's forward-only, like migration 1.
2. Dev databases go through the migration normally. Migration 1 is not edited.
3. Rollback means restoring `opendevhub.db` from before the upgrade. An older opendevhub refuses the newer schema, as specified.

## Open Questions

- Should the drafted brief be shown as a preview in the chat before Make task, or only in the dialog? Dialog only, for now.
- Should the chat composer have a "Make task" slash command (`/task`) as well as the header button? It's cheap to add later.
- Do drafts need ordering or priority (a real backlog), or is creation order enough for now? Creation order is assumed.
