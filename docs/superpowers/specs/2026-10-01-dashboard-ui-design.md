# Dashboard UI redesign — concept

Date: 2026-10-01
Status: Implemented on `ui/dashboard-redesign`

## Problem

The dashboard renders every project as one card that contains everything: state
pills, five buttons, every forwarded port, every session, and an inline log
panel. With a handful of projects that each have a few ports and a dozen
sessions, the page becomes one long scroll, and the thing the user actually
opens the dashboard for — "which agent is waiting on me?" — is buried inside
whichever card it happens to be in.

## Principles

1. **Attention first.** Sessions that need permission or an answer are the
   primary signal. They are pulled out of their projects and shown at the top,
   and counted in the sidebar and the tab title.
2. **Overview vs. detail.** The overview shows one compact tile per project
   (state, counts, one contextual action). Everything long — session lists,
   ports, logs — lives on the project's own page.
3. **Stable navigation.** Projects stay in a fixed (alphabetical) order in the
   sidebar so muscle memory works; status is shown with dots and badges rather
   than by reordering.
4. **Progressive disclosure.** Idle sessions collapse after a few, rarely used
   actions (rebuild, restart opencode) move into a menu, ports become a table.
5. **Keyboard reachable.** `⌘K` / `Ctrl+K` opens a palette that jumps to any
   page, project or session.

## Information architecture

```
┌ Sidebar ───────────┐┌ Main ─────────────────────────────────────────┐
│ opendevhub         ││ /                 Overview                     │
│ ▸ Overview         ││   stats · Needs you · Projects grid · Active   │
│ ▸ Sessions    (2)  ││ /sessions         All sessions (filter/search) │
│ PROJECTS  [filter] ││ /p/:id            Project → Sessions tab       │
│ ● api          2   ││ /p/:id/ports      Project → Ports tab          │
│ ● web              ││ /p/:id/logs       Project → Logs tab           │
│ ○ infra            ││                                                │
│ ── roots, notify,  ││                                                │
│    rescan, status  ││                                                │
└────────────────────┘└────────────────────────────────────────────────┘
```

- **Overview (`/`)** — stat row (projects running, sessions running, needs
  you, forwarded ports); a *Needs you* list with direct "Respond" links; a
  filterable grid of project tiles; a short list of currently running
  sessions.
- **Sessions (`/sessions`)** — every session across projects in one table,
  attention first then most recent, with status chips (with counts), a project
  filter and a text search. Filters live in the URL so they survive reloads.
- **Project (`/p/:id`)** — header with state, opencode version, primary
  *Open in opencode*, Start/Stop, and a `⋯` menu for Rebuild (confirmed) and
  Restart opencode. Tabs:
  - *Sessions*: grouped Needs you / Running / Idle; idle collapses after 8.
  - *Ports*: table of label, container port, local link (with copy), status,
    plus the relay mode explained once instead of per row.
  - *Logs*: full-height live log with follow toggle and copy.

## Behaviour details

- A browser notification click navigates to the session's project and
  highlights the row.
- Tab title shows `(n) opendevhub` while n sessions need attention.
- Relative timestamps re-render every 30 s.
- Below 48rem the sidebar becomes a drawer behind a menu button.
- The server already falls back to `index.html` for unknown paths, so
  `BrowserRouter` deep links work without server changes.

## Out of scope / later

- Per-project pinning or custom ordering in the sidebar.
- Bulk actions (start/stop all).
- Favicon badge for attention counts.
