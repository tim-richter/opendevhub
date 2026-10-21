## ADDED Requirements

### Requirement: Listing saved permissions

Each running environment SHALL have a "Saved permissions" section that lists the rules opencode saved when someone answered a permission prompt with "always". For each rule it SHALL show:

- the action, such as `bash` or `edit`
- the resource pattern, such as `git push *`
- when the rule was saved or last changed

The list SHALL be read from opencode each time the section is opened, filtered to the opencode project of the environment's workspace. A stopped environment SHALL show that its container has to run first.

#### Scenario: Rules saved from prompts

- **WHEN** the user had answered "always" for `bash` on `pnpm test *` and for `edit` on `src/**`
- **THEN** the section lists both rules with their action, pattern and time

#### Scenario: Stopped container

- **WHEN** the user opens the section for an environment whose container is stopped
- **THEN** it says to start the container to see saved permissions and lists nothing

### Requirement: Removing a saved permission

The user SHALL be able to remove a saved rule. After removal, opencode SHALL ask again the next time the agent wants that action on a matching resource. A rule that is already gone SHALL be treated as removed.

#### Scenario: Revoking a rule

- **WHEN** the user removes the `bash` / `git push *` rule
- **THEN** opendevhub sends `DELETE /api/permission/saved/<id>`, the rule leaves the list, and the agent's next `git push` raises a permission prompt

#### Scenario: Removed elsewhere

- **WHEN** the user removes a rule that someone else already removed in opencode
- **THEN** the rule leaves the list without an error

### Requirement: Editing a saved permission

On opencode 2.1 or later, the user SHALL be able to change a rule's action or resource pattern. Empty values SHALL be refused. On older opencode, editing SHALL NOT be offered.

#### Scenario: Narrowing a pattern

- **WHEN** the user changes `pnpm *` to `pnpm test *`
- **THEN** opendevhub sends `PATCH /api/permission/saved/<id>` with the new resource, and the list shows the updated rule

#### Scenario: opencode 2.0.x

- **WHEN** the environment runs opencode 2.0.32
- **THEN** rules can be removed but have no edit action

### Requirement: Finding it from a prompt

A permission prompt's "always" choice SHALL tell the user that the rule can be managed later, and link to the environment's Saved permissions section.

#### Scenario: Answering always

- **WHEN** the user looks at a permission prompt
- **THEN** the "always" choice has a hint linking to Saved permissions
