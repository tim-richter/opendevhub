# task-page-layout Specification

## Purpose

The task page's layout and what each region shows: the active variants, the header, the progress stepper, the variant and conversation sidebar, the Runtime tab, the status rail, the composer's target and the phone layout.

## Requirements

### Requirement: Active variants

A variant SHALL be _active_ when it was not discarded, whether it is starting, running, idle or failed and not yet dismissed. Everything on the task page that tells variants apart SHALL appear only when the task has two or more active variants:

- the variant cards
- the phone variant control
- the Compare variants button
- variant names in labels, such as "Conversations in V2" or "To V2"

With one active variant, the page SHALL show that variant's content with no variant UI.

#### Scenario: Single-variant task

- **WHEN** the user opens a task that started with one variant
- **THEN** the page shows no variant cards, no Compare variants button, and the sidebar's conversation section is titled "Conversations"

#### Scenario: After a pick

- **WHEN** the user picks variant 2 of a three-variant task, discarding 1 and 3
- **THEN** the variant cards and the Compare variants button disappear, and the page shows variant 2

#### Scenario: Two variants running

- **WHEN** a task has two active variants
- **THEN** the sidebar shows one card for each, and the header shows Compare variants

### Requirement: Task header

The task page SHALL start with a header that holds:

- a breadcrumb: the project (linked), the task kind, and the ticket key (linked) when the task has a ticket
- the task title, with one attention pill
- on the right, Compare variants (when two or more variants are active) and a "More task actions" menu

The pill SHALL read:

- Needs you, when an active variant's session waits on a permission or question
- else Working, when one is running
- else Starting, when one is being set up
- else Ended, for an ended task
- else Idle

The More task actions menu SHALL hold Activity, Open in (when the selected variant has a local checkout), and Archive (for an ended task). The header SHALL show the task's pull request badges, "from chat", "Review of PR #n" and the total usage as secondary metadata, and SHALL NOT have a checks button.

#### Scenario: Waiting on permission

- **WHEN** variant 2 of a task waits for permission to run a command
- **THEN** the header's pill reads "Needs you"

#### Scenario: Archiving

- **WHEN** the user opens More task actions on an ended task
- **THEN** the menu offers Archive, and choosing it archives the task as the Archive button did

### Requirement: Progress stepper

A task of kind `task` SHALL show a progress stepper under its title, with these steps in order:

- Brief
- Agents
- Pick variant, only when the task started with two or more variants
- Review & checks
- Publish
- Pull request

Each step SHALL be worked out from the task, the selected variant and its checkout:

- Brief is done once the task is not a draft.
- Agents is done when no active variant's session is running or waiting on the user. Its label SHALL include the count of active variants when there are two or more.
- Pick variant is done when a variant is picked.
- Review & checks is done when the selected variant's checks passed, or none are set up, and it has no uncommitted changes. When an AI review or Open Code Review was started for the variant, it is also not done until that review has finished.
- Publish is done when the selected variant's branch is pushed.
- Pull request is done when a pull request is linked to the selected variant.

The first step that isn't done SHALL be marked current (`aria-current="step"`). Done steps SHALL show a check mark. An AI review task SHALL NOT show the stepper.

#### Scenario: Two agents working

- **WHEN** both variants of a two-variant task are running
- **THEN** the stepper shows Brief done and "Agents · 2" current, followed by Pick variant, Review & checks, Publish and Pull request

#### Scenario: Picked and pushed

- **WHEN** a task's picked variant is idle, its checks passed, its branch is pushed and no pull request is linked
- **THEN** Pull request is the current step

#### Scenario: Single-variant task

- **WHEN** a task started with one variant
- **THEN** the stepper has no Pick variant step

#### Scenario: AI review still running

- **WHEN** the selected variant's checks passed, it is fully committed, and an AI review of it is still running
- **THEN** Review & checks is the current step

### Requirement: Variant and conversation sidebar

At widths of 768px and more, the task page SHALL show a left sidebar beside the selected variant's view.

When two or more variants are active, its Variants section SHALL list one card per active variant. Each card SHALL show:

- the variant's number
- its model's short name
- its state (Working, Needs you, Idle, Starting with its setup step, or Failed)
- its branch
- its line additions and deletions
- its checks as passed out of total
- its cost

Selecting a card SHALL select that variant (the `v` parameter) and keep the current tab. The selected card SHALL be marked with `aria-current`.

Its Conversations section SHALL list the selected variant's conversations, the variant's own first. Selecting one SHALL show it on the Conversation tab (the `thread` parameter). Each entry SHALL offer to close it. The section SHALL end with New conversation, which starts a conversation with fresh context in the variant's checkout.

From 768px up to 1024px, the sidebar SHALL collapse to an icon strip:

- each variant as its number with a state dot
- one conversations button, which opens the list as a popover
- New conversation

From 1024px it SHALL show in full.

#### Scenario: Switching variant from the sidebar

- **WHEN** the user is on `/p/x/t/abc/terminal?v=1` and selects variant 2's card
- **THEN** the URL becomes `/p/x/t/abc/terminal?v=2`

#### Scenario: Second conversation

- **WHEN** the user clicks New conversation in the sidebar
- **THEN** a conversation starts in the selected variant's checkout, appears in the list, and the Conversation tab shows it

#### Scenario: Starting variant

- **WHEN** a variant is still creating its worktree
- **THEN** its card shows "Starting" with its setup step, and selecting it shows its setup log in the main area

#### Scenario: Narrow laptop

- **WHEN** a two-variant task is viewed at 900px wide
- **THEN** the sidebar shows V1 and V2 as icons with state dots, and the conversations open from a button

### Requirement: Runtime tab controls

The Runtime tab SHALL start with a card for the environment the selected variant runs in. The card SHALL show:

- the container's name and state
- opencode's state and version
- whether it is the variant's own container or the project's shared one
- whether it runs locally or on a node

It SHALL offer these actions, each disabled with a reason while another lifecycle action runs:

- Restart opencode
- Rebuild (with a "without cache" option)
- Stop, or Start when stopped
- Remove container, for a variant's own container only

Stop and Remove SHALL ask for confirmation. For the shared container, the confirmation SHALL say that it affects every checkout and conversation using it. Below the card, the tab SHALL keep the forwarded ports and host ports.

#### Scenario: Restarting opencode

- **WHEN** the user clicks Restart opencode on a variant with its own container
- **THEN** that container's opencode is relaunched and the card shows it as starting, then healthy

#### Scenario: Stopping a shared container

- **WHEN** the user clicks Stop on a variant that runs in the project's shared container
- **THEN** a confirmation says that every checkout in the project's container stops, and nothing stops until it is confirmed

### Requirement: Runtime tab logs

The Runtime tab SHALL show the logs of the selected variant's environment, with a source filter:

- **All**
- **Setup**: what opendevhub wrote while creating, starting and forwarding it
- **Container**: the container's own output
- **opencode**: the output of the opencode server inside the container

All SHALL interleave the sources by time where times are known, and otherwise show each source in turn. Setup lines SHALL be only that environment's, not the whole project's. The logs SHALL refresh while the tab is open and follow the end unless the user has scrolled up. A source that can't be read, such as a stopped container's opencode log, SHALL say why instead of showing nothing.

#### Scenario: opencode output

- **WHEN** the user filters a running variant's logs to opencode
- **THEN** the tab shows the last lines the opencode server wrote in that variant's container

#### Scenario: Own container's setup

- **WHEN** variant 2 runs in its own container and the user filters to Setup
- **THEN** the tab shows only variant 2's environment lines, not those of the project's other containers

#### Scenario: Stopped container

- **WHEN** the variant's container is stopped and the user picks opencode
- **THEN** the tab says the container is stopped, so opencode's log can't be read

### Requirement: Status rail

At widths of 1440px and more, the task page SHALL show a right rail for the selected variant with three sections:

- **Target**: the branch and the branch it started from, the container and its state, and whether it runs locally or on a node.
- **Checks**: each check's name and state, and Run all.
- **Changes**: the number of changed files, line additions and deletions, and a Review changes link to the Review page.

From 768px up to 1440px, the page SHALL instead show a status strip at the end of the tab bar row. The strip SHALL show the branch, the environment, the number of failing checks when any fail, and a Review link to the Review page.

The rail's checks SHALL NOT offer to send a failure to the agent.

#### Scenario: Failing check on a wide screen

- **WHEN** the selected variant's typecheck failed and the window is 1440px wide
- **THEN** the rail lists typecheck as failed among the checks

#### Scenario: Failing check on a laptop

- **WHEN** the same task is viewed at 1280px
- **THEN** no rail is shown, and the tab bar row ends with the branch, the environment, "1 failing" and Review

### Requirement: Composer target

The composer on the Conversation tab SHALL be labelled with whom it writes to:

- "To V<n>" followed by the branch, when two or more variants are active
- otherwise, the branch alone

#### Scenario: Two variants

- **WHEN** variant 2 on branch `feat/oauth-b` is selected and two variants are active
- **THEN** the composer label reads "To V2 · feat/oauth-b"

#### Scenario: One variant

- **WHEN** a task has one active variant on branch `feat/oauth`
- **THEN** the composer label reads "feat/oauth", with no variant name

### Requirement: Phone layout

Below 768px, the task page SHALL show:

- a back link to the project, and the title
- a "Task actions" button
- a variant segmented control, only when two or more variants are active
- "Step n of m · <current step>" in place of the stepper
- the tabs, scrolling sideways, including a Checks tab that holds the status rail's content and is labelled with the number of failing checks
- a branch chip above the content, and the composer pinned to the bottom of the screen

There SHALL be no sidebar or rail. Conversations SHALL be reached from the Conversation tab. Touch targets SHALL be at least 44px.

#### Scenario: Phone with two variants

- **WHEN** a two-variant task is opened on a 390px wide screen
- **THEN** the page shows a V1/V2 segmented control with each variant's state dot, "Step 2 of 6 · Agents", and tabs including Checks

#### Scenario: Phone with one variant

- **WHEN** a single-variant task is opened on a phone
- **THEN** no variant control is shown
