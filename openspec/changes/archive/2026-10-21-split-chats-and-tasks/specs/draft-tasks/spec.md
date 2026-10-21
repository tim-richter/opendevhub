## ADDED Requirements

### Requirement: Creating a draft task

The New task dialog SHALL offer Save as draft next to Start. Save as draft SHALL create a task of kind `task` with the title, brief, links, spec-first choice and the requested variants' model and agent kept as the draft's plan, and no variants. A task SHALL be `draft` while it has no variants.

#### Scenario: Draft from the dialog

- **WHEN** the user fills in "Add login" and clicks Save as draft
- **THEN** a task "Add login" in state `draft` exists with no variants, and no worktree or session is created

### Requirement: Draft from a ticket

The Jira ticket page SHALL offer Create draft next to Start task. After the user chooses the project, it SHALL create a draft titled from the ticket, linked to it, with the ticket's description as the brief, without opening a dialog.

#### Scenario: Backlog from Jira

- **WHEN** the user clicks Create draft on `APP-42` and chooses project `app`
- **THEN** a draft task linked to `APP-42` exists in `app`, and the ticket page lists it

### Requirement: Starting a draft

A draft's task page SHALL show its brief, links and plan instead of the tabs, with Start and Edit. Start SHALL open the New task dialog filled from the draft. Confirming SHALL add the variants to the same task, keeping its id, and the task SHALL leave `draft`. Edit SHALL change the draft without starting it.

#### Scenario: Start a draft

- **WHEN** the user starts draft `abc` with two variants
- **THEN** task `abc` gets variants 1 and 2, its state becomes `starting`, and its page shows the usual tabs

### Requirement: Drafts in the lists

The project page and the Tasks page SHALL list draft tasks in their own Drafts group, above running tasks on the project page. Drafts SHALL NOT appear in Needs you. A draft SHALL be archivable like any task.

#### Scenario: Project page with a draft

- **WHEN** project `app` has one draft and one running task
- **THEN** the project page shows a Drafts group with the draft and a Tasks group with the running task
