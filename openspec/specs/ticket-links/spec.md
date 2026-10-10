# ticket-links Specification

## Purpose

How opendevhub records the Jira tickets tasks are started from: rows keyed by instance and key, refreshed title and status, lookups from a ticket to its tasks and pull requests, the Jira and task pages that show them, and the events for new links.

## Requirements

### Requirement: Ticket records

The system SHALL keep a ticket row for every Jira ticket a task is started from, keyed by its instance URL and key, with its web URL. The system SHALL refresh the title and status whenever the Jira integration fetches the ticket.

#### Scenario: Task from a ticket

- **WHEN** the user starts a task from ticket `APP-42`
- **THEN** a ticket row for that instance and `APP-42` exists and the task references it

#### Scenario: Ticket status refreshed

- **WHEN** the Jira page lists `APP-42` with status "In Review"
- **THEN** the ticket row's status is "In Review"

#### Scenario: Snapshot kept on the task

- **WHEN** the ticket's title changes in Jira after the task started
- **THEN** the task keeps the Jira snapshot it was started with, and the ticket row has the new title

### Requirement: Lookups from a ticket

The system SHALL return, for a ticket: the tasks started from it (archived ones included), and the pull requests linked with role `head` to those tasks' variants' branches.

#### Scenario: Ticket with a published task

- **WHEN** the client looks up `APP-42`, whose task's variant 1 was published as a pull request
- **THEN** the result has that task and that pull request

#### Scenario: Ticket with no tasks

- **WHEN** the client looks up a ticket with no row
- **THEN** the result is empty, not an error

### Requirement: Jira page uses the lookup

The Jira ticket page SHALL list the ticket's tasks and pull requests from the lookup, and SHALL NOT scan the tasks in the snapshot.

#### Scenario: Ticket with tasks in two projects

- **WHEN** tasks were started from the same ticket in two projects
- **THEN** the ticket page lists both tasks with their projects, and the pull requests of each

#### Scenario: Task whose sessions are gone

- **WHEN** a task started from the ticket has ended and its sessions were removed
- **THEN** the ticket page still lists the task

### Requirement: Tasks show their ticket

Each task in the snapshot that was started from a ticket SHALL include the ticket's key, URL, title and status.

#### Scenario: Task page

- **WHEN** the user opens a task started from `APP-42`
- **THEN** the task page shows `APP-42` with its status, linking to the ticket

### Requirement: Ticket links are recorded as events

The system SHALL append a `ticket.linked` event when a task is started from a ticket, in the same transaction as the link, with the task's id. Refreshing a ticket's title or status SHALL NOT be recorded as an event.

#### Scenario: Task from a ticket

- **WHEN** the user starts a task from ticket `APP-42`
- **THEN** a `ticket.linked` event for `APP-42` with the task's id is recorded
