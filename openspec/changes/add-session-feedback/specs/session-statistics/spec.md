## ADDED Requirements

### Requirement: Statistics for a chat or task variant

opendevhub SHALL build a statistics summary for a chat, or for one variant of a task, from its opencode session and every subagent session below it. The summary SHALL include:

- the kind (`chat`, `task` or `review`)
- the model and agent the session last used
- the opencode version
- the duration from the first message to the last activity
- the number of user turns and the number of compactions
- the total cost in USD
- input, output, reasoning, cache-read and cache-write tokens

Subagent sessions SHALL be counted into these totals.

#### Scenario: Chat with a subagent

- **WHEN** a chat's session cost $0.40 and its one subagent session cost $0.10
- **THEN** the summary reports a cost of $0.50 and the tokens of both sessions

#### Scenario: Session removed

- **WHEN** the chat's opencode session has been removed
- **THEN** opendevhub reports that no statistics are available, and doesn't build an empty summary

### Requirement: Tool usage

The summary SHALL count tool calls per tool name, and for each tool how many ended in an error. A tool call whose name opencode gives as `<server>_<tool>` for a configured MCP server SHALL be counted under `mcp`, grouped by server and tool, and not under the built-in tools. The summary SHALL list:

- the skills loaded (by skill name)
- the subagents started (by agent name)
- the slash commands the user ran (by command name)

#### Scenario: Built-in tools

- **WHEN** the session ran `bash` five times, and one of those calls failed
- **THEN** the summary reports `bash` with 5 calls and 1 error

#### Scenario: MCP tool

- **WHEN** the session called the `context7` server's `query-docs` tool twice
- **THEN** the summary reports `mcp.context7.query-docs` as 2 calls, and doesn't list it among the built-in tools

#### Scenario: Skill loaded

- **WHEN** the session loaded the `openspec-propose` skill
- **THEN** the summary lists `openspec-propose` under skills

### Requirement: Outcome signals

The summary SHALL include:

- opencode's session outcome, when it gives one
- the number of permission requests asked and denied
- the number of files changed, and lines added and removed, across the session
- for a task variant: whether it was picked or discarded, how many variants the task had, whether its branch was published, whether a pull request is linked, and the number of findings in its newest review

#### Scenario: Picked variant with a pull request

- **WHEN** variant 2 of a three-variant task was picked, its branch published, and a pull request linked whose last review had 3 findings
- **THEN** the summary reports picked, 3 variants, branch published, pull request linked, and 3 review findings

### Requirement: Nothing private in the summary

The summary SHALL hold only counts, durations, names of models, agents, tools, MCP servers, skills and commands, and the project's name. It SHALL NOT include prompt or reply text, reasoning, tool arguments or output, file paths, branch names, diffs, ticket or pull request URLs, or any credential.

#### Scenario: Tool call with arguments

- **WHEN** the session ran `bash` with the command `cat .env`
- **THEN** the summary counts one `bash` call, and the command appears nowhere in it
