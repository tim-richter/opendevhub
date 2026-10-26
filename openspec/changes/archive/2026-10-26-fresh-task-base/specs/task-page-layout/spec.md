## MODIFIED Requirements

### Requirement: Status rail

At widths of 1440px and more, the task page SHALL show a right rail for the selected variant with three sections:

- **Position**: where the variant's branch stands, as a small diagram with one row per ref, top to bottom:
  - the base's upstream (for example `origin/main`), with the number of commits it gained since the branch was made
  - the local base, with how far it is behind its upstream, when it is behind
  - the point where the branch was made (its merge-base with the base)
  - the branch's HEAD, with the commits it is ahead of the base and whether it has uncommitted changes
  - the branch's upstream, when it was pushed, with the commits not yet pushed

  Runs of commits SHALL be drawn as one edge labelled with their count, so the diagram's height doesn't depend on how many commits there are. The section SHALL also show the container and its state, whether it runs locally or on a node, and how long ago the remote was last fetched. It SHALL offer a fetch action, and a Pull action when the local base is behind its upstream and can be safely fast-forwarded (as in `fresh-task-base`). For a variant that runs in the main checkout, the branch is the base itself, so the diagram SHALL show only the base's upstream and the local base.

- **Checks**: each check's name and state, and Run all.
- **Changes**: the number of changed files, line additions and deletions, and a Review changes link to the Review page.

From 768px up to 1440px, the page SHALL instead show a status strip at the end of the tab bar row. The strip SHALL show the branch, its commits ahead of and behind the base's upstream, the environment, the number of failing checks when any fail, and a Review link to the Review page.

The rail's checks SHALL NOT offer to send a failure to the agent. The Position section SHALL NOT animate when it appears; when a count changes it MAY transition only colour and opacity.

#### Scenario: Failing check on a wide screen

- **WHEN** the selected variant's typecheck failed and the window is 1440px wide
- **THEN** the rail lists typecheck as failed among the checks

#### Scenario: Failing check on a laptop

- **WHEN** the same task is viewed at 1280px, its branch is 3 commits ahead of `origin/main` and 2 behind
- **THEN** no rail is shown, and the tab bar row ends with the branch, ↑3 ↓2, the environment, "1 failing" and Review

#### Scenario: Upstream moved during the task

- **WHEN** `origin/main` gains 4 commits after the variant branched, the user opens the task, and the last fetch is older than 5 minutes
- **THEN** opendevhub fetches, and the Position section shows `origin/main` 4 commits past the branch point and local `main` 4 behind, with a Pull action

#### Scenario: Pull from the rail

- **WHEN** the user clicks Pull while the main checkout is clean and on `main`
- **THEN** `main` is fast-forwarded to `origin/main` and the local base row no longer shows it as behind

#### Scenario: Pull not possible

- **WHEN** the main checkout has uncommitted changes
- **THEN** the Pull action is disabled, with a tooltip saying the main checkout has uncommitted changes
