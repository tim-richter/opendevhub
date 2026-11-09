## MODIFIED Requirements

### Requirement: Conversation transcript

A conversation SHALL be shown as a transcript of its messages, oldest at the top, newest at the bottom. A user message SHALL be shown as a bubble with its full text. An assistant message SHALL show its parts in order:

- text, rendered as markdown
- reasoning, collapsed to a "Thinking" row that expands to the full text
- each tool call as one row with the tool's name, its title when opencode gives one, and its status (running, done or failed)

A failed assistant message SHALL show its error inline. A compaction SHALL be shown as a divider saying the conversation was compacted. When the session has messages older than those read, the top of the transcript SHALL say so and link to the conversation in opencode. While a revert is staged, the transcript and the Turns panel SHALL leave out the message the revert is staged at and every message after it.

#### Scenario: A back-and-forth

- **WHEN** the user asked "add dark mode", the agent replied with a question, and the user answered "yes, use CSS variables"
- **THEN** the transcript shows the user's bubble, the agent's question, then the user's answer, in that order from top to bottom

#### Scenario: Tool calls are compact

- **WHEN** an assistant message ran `bash` with title `pnpm test` and it failed
- **THEN** the transcript shows one row naming `bash` and `pnpm test`, marked as failed

#### Scenario: Older messages left out

- **WHEN** a session has more messages than the detail reads
- **THEN** the top of the transcript says older messages are left out and links to the conversation in opencode

#### Scenario: Empty conversation

- **WHEN** a session has no messages yet
- **THEN** the transcript says the conversation hasn't been prompted yet

#### Scenario: Revert staged

- **WHEN** a revert is staged at the second of four user messages
- **THEN** the transcript shows only the first user message and the agent's reply to it, and the Turns panel lists only that turn
