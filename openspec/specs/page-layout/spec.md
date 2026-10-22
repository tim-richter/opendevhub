# page-layout Specification

## Purpose

How the shell lays out every page: three layouts (index, document, workspace) that routes declare, content anchored to the left edge, a full-width header row, which pages use which layout, and the one centred exception.

## Requirements

### Requirement: Every route declares a page layout

Every page route SHALL use exactly one of three page layouts: `index`, `document` or `workspace`. A route that declares no layout SHALL use `index`. The shell SHALL apply the layout's width, padding and viewport fill. Pages SHALL NOT set their own outer width, horizontal centering or viewport height.

#### Scenario: Route without a declaration

- **WHEN** a new page route is added without declaring a layout
- **THEN** it renders with the `index` layout

#### Scenario: Layout of a nested route

- **WHEN** a parent route and its child route both declare a layout
- **THEN** the child's layout applies

### Requirement: Content is left-anchored

Page content SHALL start at the shell's left content edge on every page and layout. A layout MAY limit how far content extends to the right, but SHALL NOT center the page horizontally. On a given screen width, the page title SHALL appear at the same horizontal position on every page.

#### Scenario: Switching from a wide page to a capped page

- **WHEN** the user goes from an `index` page to a `document` page on a 1920px-wide window
- **THEN** the page title starts at the same x position on both pages, and only the `document` page's body ends further left

### Requirement: Full-width page header

The page header row (title and description on the left, actions on the right) SHALL span the full content width in every layout, including `document`. On a given screen width, primary header actions SHALL appear at the same right edge on every page.

#### Scenario: Header on a document page

- **WHEN** a `document` page renders on a wide window
- **THEN** its header actions sit at the content's right edge, as they do on Tasks, while the body below is capped

### Requirement: Index layout

The `index` layout SHALL let the page body use the full content width. Lists, tables, boards, grids and dashboards SHALL use it.

#### Scenario: Index pages

- **WHEN** the user opens the Dashboard (`/`), Tasks, Chats, Jira (list or board), a Jira ticket, Forgejo, a Forgejo pull request, a project's overview, a project's To-do page, or a checkout
- **THEN** the page uses the `index` layout

#### Scenario: Jira list and board

- **WHEN** the user switches the Jira page between list and board
- **THEN** the page's width and title position do not change

### Requirement: Document layout

The `document` layout SHALL cap the page body (everything below the header) at a single shared maximum width, anchored to the left edge. All `document` pages SHALL use the same cap.

#### Scenario: Document page body

- **WHEN** the user opens a page that declares the `document` layout
- **THEN** its body is capped at the shared document width and starts at the left content edge, while its header spans the full width

#### Scenario: No page uses it yet

- **WHEN** this change ships
- **THEN** no route declares `document`; the layout is available for reading pages added later

### Requirement: Workspace layout

The `workspace` layout SHALL fill the viewport below the shell's top padding, with no bottom padding, so that a pinned composer or terminal sits at the bottom of the window. Inside a workspace, the chat transcript and its composer SHALL be a horizontally centered reading column, as in other AI chat tools. The workspace's header row SHALL still follow the full-width header rule.

#### Scenario: Task conversation

- **WHEN** the user opens a task's Conversation tab
- **THEN** the page fills the viewport, the header starts at the left content edge, and the transcript and composer are a centered column

#### Scenario: Task tabs that do not fill

- **WHEN** the user opens a task's Changes, Runtime, Spec, Checks or Compare tab
- **THEN** that tab uses the `index` layout

#### Scenario: Chat view

- **WHEN** the user opens a chat
- **THEN** the page uses the `workspace` layout with a centered transcript and composer

### Requirement: Dashboard uses the standard header

The home Dashboard SHALL be an ordinary `index` page with the standard page header, with no eyebrow label and no oversized title.

#### Scenario: Opening the dashboard

- **WHEN** the user opens `/`
- **THEN** the title "Dashboard" has the same size and position as "Tasks" on the Tasks page

### Requirement: Chat start is a centered landing page

The Chat start page (`/chat`) SHALL be the only exception to the left-anchored rule: its composer SHALL be centered horizontally and vertically in the viewport.

#### Scenario: Starting a chat

- **WHEN** the user opens `/chat`
- **THEN** the composer appears centered in the window, with no page header
