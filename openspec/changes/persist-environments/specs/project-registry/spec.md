## ADDED Requirements

### Requirement: Project records

The system SHALL keep a project row for every project discovery finds, keyed by the project id derived from its path. Each row SHALL have its path, name, devcontainer path and the time it was first seen. Tasks, branches, worktrees and environments SHALL reference their project row.

#### Scenario: New project discovered

- **WHEN** discovery finds a project folder for the first time
- **THEN** a project row exists with that project's id, path and name, and the time it was first seen

#### Scenario: Foreign keys

- **WHEN** a task is created for a project
- **THEN** the task row references that project's row

### Requirement: Missing projects are kept

When a project is no longer discovered, the system SHALL mark its row missing and SHALL keep the project row and everything that references it. When the project is found again at the same path, the system SHALL clear the missing mark.

#### Scenario: Project folder moved away

- **WHEN** a project that has tasks is no longer found by discovery
- **THEN** its row is marked missing, it leaves the dashboard, and its tasks remain in the database

#### Scenario: Project comes back

- **WHEN** the folder reappears at the same path
- **THEN** its row is no longer marked missing and its tasks show in the dashboard again

### Requirement: Existing project ids are kept valid

When the database is upgraded, the system SHALL create a placeholder project row, marked missing, for every project id that existing rows use but discovery has not produced. Discovery SHALL replace the placeholder's path and name when it finds that project.

#### Scenario: Upgrade before discovery runs

- **WHEN** the upgrade runs while tasks exist for project `app-1a2b3c`
- **THEN** a placeholder row for `app-1a2b3c` exists and the tasks keep referencing it

#### Scenario: Placeholder filled in

- **WHEN** discovery then finds project `app-1a2b3c`
- **THEN** its row has the real path and name and is no longer marked missing
