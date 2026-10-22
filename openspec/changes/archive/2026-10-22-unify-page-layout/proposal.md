## Why

Every page picks its own width and alignment: full width, `max-w-3xl` through `max-w-7xl`, some centered with `mx-auto`, some not. Switching pages moves the title by hundreds of pixels on a wide screen, so the dashboard feels like several apps stitched together. A single layout concept owned by the shell gives every page the same anchor.

## What Changes

- Introduce three page layouts — **index**, **document**, **workspace** — that each route declares; the shell applies the width, padding and viewport fill instead of each page doing it.
- All page content starts at the shell's left edge; pages no longer center themselves with `mx-auto`. A page may only limit how far it extends to the right.
- The page header row (title left, actions right) always spans the full content width, so title and primary actions sit in the same place on every page.
- **index** pages have an uncapped body; **document** pages cap their body at one shared width, left-anchored. No page uses **document** yet; To-do uses **index**.
- **workspace** pages fill the viewport below the shell's top padding; the chat transcript and composer stay a centered reading column, as in other AI tools.
- The home Dashboard drops its hero header and becomes an ordinary index page with the standard `PageHeader`.
- The Jira page uses the index layout in both list and board mode (it no longer changes width when switching).
- The `/chat` start page stays an exception: a centered composer landing page.
- The `fillViewport` class with its copied padding numbers is replaced by the workspace layout.

## Capabilities

### New Capabilities

- `page-layout`: the page layouts (index, document, workspace), the left-anchored rule, the full-width header row, which pages use which layout, and the exceptions.

### Modified Capabilities

<!-- none: existing specs do not state page widths or alignment -->

## Impact

- `apps/opendevhub/src/web/shell/shell.tsx` — reads the matched route's layout and wraps the outlet accordingly.
- `apps/opendevhub/src/web/app.tsx` — routes declare `staticData.layout`.
- `apps/opendevhub/src/web/components/page.tsx` — `Page`/`PageHeader` adapt to the layout; `fillViewport` removed.
- Pages: `features/projects/overview.tsx` (home), `project-todos.tsx`, `project-overview.tsx`, `features/jira/jira-page.tsx` (list, board, ticket), `features/forgejo/forgejo-page.tsx`, `features/tasks/tasks-page.tsx`, `project-task.tsx`, `features/chat/chats-page.tsx`, `chat-view.tsx`, `chat-start.tsx`, `features/checkouts/checkout-page.tsx`, `features/sessions/conversation.tsx`.
- Storybook stories that render pages may need the layout wrapper.
- No API, server or data changes.
