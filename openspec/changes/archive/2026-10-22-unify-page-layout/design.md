## Context

The shell (`shell/shell.tsx`) wraps every route's `<Outlet />` in padding only (`px-4 pt-4 pb-12 md:px-8 md:pt-6 md:pb-16`). Each page then picks its own outer width and alignment:

| Page | Today |
| --- | --- |
| Dashboard `/` | `mx-auto max-w-5xl`, hero header (eyebrow + 3xl/4xl title) |
| Tasks, Chats, Forgejo, project overview, checkout | full width |
| Jira list / board | `mx-auto max-w-7xl` / full width (same route) |
| Jira ticket | `mx-auto max-w-6xl`, body + 18rem sidebar at `lg` |
| To-do | `mx-auto max-w-3xl` |
| Task page | full width; Conversation and Terminal tabs add `fillViewport` |
| Chat view | `fillViewport`; transcript column `mx-auto max-w-4xl` |
| Chat start | `mx-auto max-w-3xl`, vertically centered, hand-copied viewport maths |

`fillViewport` (`components/page.tsx`) and the chat start page copy the shell's padding into magic numbers (`-mb-8 h-[calc(100svh-5.25rem)] md:-mb-10 md:h-[calc(100svh-3rem)]`). If the shell's padding changes, they break.

## Goals / Non-Goals

**Goals:**

- The page title, and the header actions, stay in the same place when switching pages.
- One place (the shell) owns outer width, padding and viewport fill.
- Few, named layouts instead of per-page widths.

**Non-Goals:**

- Redesigning page contents, sidebars (left or right) or dialogs. Settings and project settings stay dialogs.
- Changing the phone layout beyond what follows from removing `mx-auto` (phones are already full width).
- An ultrawide safety cap on `index` pages. If needed later, it's one value in the shell.

## Decisions

### Three layouts declared on routes via `staticData`

Routes declare `staticData: { layout: "index" | "document" | "workspace" }`. Augment TanStack Router's `StaticDataRouteOption` so the field is typed. The shell reads `useMatches()` and takes the deepest match that declares a layout, defaulting to `index`.

_Why:_ the router already knows which page is showing, so the shell can lay it out before the page renders, and child routes (task tabs) can override their parent. _Alternative:_ each page wraps itself in `<Page layout="…">`. Rejected: the layout would again live in 15 places, and the shell couldn't own the viewport fill or bottom padding.

### The shell applies padding and fill; `Page` applies the document cap

The shell wraps the outlet in a container with `data-layout` and the layout's padding:

- `index` / `document`: the current padding.
- `workspace`: the same top and side padding, no bottom padding, and a fixed height of the remaining viewport (`flex` column, `min-h-0`), so children can pin a composer to the bottom and scroll internally. This replaces `fillViewport`; the height is computed where the padding is defined.

The shell provides the layout through a small context (`usePageLayout()`). For `document`, `Page` caps every child except `PageHeader` at the shared document width (`max-w-3xl`). `PageHeader` always stays full width.

_Why:_ the full-width-header rule means the cap can't sit on the shell's wrapper. `Page` already wraps header and body on every page, so it's the natural place to separate them. _Alternative:_ a separate `PageBody` component that document pages wrap their body in. That's workable, but easy to forget. Capping in `Page` means a page only declares its layout.

### Remove `mx-auto` from pages

Every page-level `mx-auto max-w-*` goes away (Dashboard, Jira list/board/ticket, To-do). Inner content constraints that aren't page width stay, such as the `max-w-xl` description text and dialog widths.

### To-do uses `index`, not `document`

To-do was planned as the first `document` page, but in the running app its body stopped just short of the right edge at common window widths: the 48rem cap barely applied, so the right margin didn't match the left and looked like a mistake. It uses `index` (full width) like the other pages. The `document` layout stays in place, unused, for reading pages added later.

### Jira ticket uses `index`, not `document`

The ticket body has an 18rem sidebar from `lg` up. Inside the 48rem document cap, that leaves about 27rem for the description, which is too narrow. As an `index` page it is left-anchored, full width, and its main column keeps a readable measure through the existing prose styles.

### Task tabs choose their own layout

The task route declares nothing. Its Conversation and Terminal tab routes declare `workspace`, and the others fall back to `index`. That matches today's `FILL_TABS`.

There is one runtime case: while a variant is still being set up, the task page doesn't fill the viewport today (`!setup`). In a `workspace` container, the setup view is short and top-aligned, and the container scrolls if needed, so no runtime override is required. `FILL_TABS` and the `fillViewport` toggle are removed.

### Chat view and chat start are both `workspace`

The chat view (`chat/$projectId/$chat`) is a `workspace`. The transcript and composer column stays centered (`conversation.tsx`'s `COLUMN`, `chat-view.tsx`'s waiting column), which is the deliberate exception inside workspaces.

The chat start page (`/chat`) is also a `workspace`. It centers its composer horizontally and vertically inside the container, so its hand-copied `min-h-[calc(…)]` / `-mb-*` maths goes away. It's the one page-level exception to left-anchoring, and it has no header to misplace.

### Dashboard header

Replace the Dashboard's hand-built `<header>` with `PageHeader` (title "Dashboard", the existing description, and the All tasks / All chats buttons as actions). Remove the "Live workspace" eyebrow and the 3xl/4xl title.

## Risks / Trade-offs

- [Document pages leave empty space on the right on wide screens] → Accepted as the cost of a stable title.
- [Index tables stretch very wide on ultrawide monitors] → Out of scope. A shell-level cap can be added in one place later.
- [The workspace's fixed height breaks a page that expects to grow] → Only Conversation, Terminal, chat view and chat start use it. Each already fills the viewport today.
- [Capping `Page` children by selector misses content that isn't a direct child] → Document pages keep their body as direct children of `Page`.
- [Storybook stories render pages without the shell] → Give stories a decorator that provides the layout context, or have the context default to `index` so stories still render.

## Migration Plan

This is UI-only and has no data or API changes. It ships in one change. Rollback means reverting the commit.

## Open Questions

- Should the document cap be `max-w-3xl` or `4xl`? The plan starts with `3xl` and revisits once a page uses `document`.
