## ADDED Requirements

### Requirement: Conversation transcript

A conversation SHALL be shown as a transcript of its messages, oldest at the top, newest at the bottom. A user message SHALL be shown as a bubble with its full text. An assistant message SHALL show its parts in order:

- text, rendered as markdown
- reasoning, collapsed to a "Thinking" row that expands to the full text
- each tool call as one row with the tool's name, its title when opencode gives one, and its status (running, done or failed)

A failed assistant message SHALL show its error inline. A compaction SHALL be shown as a divider saying the conversation was compacted. When the session has messages older than those read, the top of the transcript SHALL say so and link to the conversation in opencode.

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

### Requirement: Composer at the bottom

The composer SHALL be pinned to the bottom of the conversation view, below the transcript, and SHALL stay visible while the transcript scrolls. Pending permission and question cards SHALL be shown between the transcript and the composer.

#### Scenario: Answering a question

- **WHEN** the agent asks a question while the user reads the transcript
- **THEN** the question card appears directly above the composer

#### Scenario: Long transcript

- **WHEN** a transcript is longer than the view
- **THEN** the transcript scrolls and the composer stays in place at the bottom

### Requirement: Following the newest message

When the conversation opens, the transcript SHALL be scrolled to its newest message. When new content arrives while the user is at the bottom, the transcript SHALL stay at the bottom. When the user has scrolled up, new content SHALL NOT move the view; a "Jump to latest" button SHALL appear instead, and it SHALL scroll to the bottom. Sending a message SHALL scroll to the bottom.

#### Scenario: Reading back while the agent works

- **WHEN** the user has scrolled up to an earlier reply and the agent adds a message
- **THEN** the view stays where it is and a "Jump to latest" button appears

#### Scenario: Following along

- **WHEN** the user is at the bottom and the agent adds a message
- **THEN** the transcript scrolls to show it

### Requirement: Transcript refreshes while the agent works

While the session is not idle, the view SHALL read the conversation again every 2 seconds. While the session is idle, it SHALL read it again when the session's summary changes in the dashboard snapshot.

#### Scenario: Reply appears

- **WHEN** the user sends a message and the agent starts replying
- **THEN** the reply appears in the transcript within a few seconds, without a reload

### Requirement: Usage popover

The conversation view's header SHALL NOT show usage cards. It SHALL show a usage button with the context used as a share of the model's context window, or the context tokens when the window is unknown. The button SHALL open a popover with the cost, the tokens with their breakdown, the context with its meter, when the conversation started, and how its last run ended. When the conversation has subagents, the cost and tokens SHALL be marked as including them.

#### Scenario: Checking cost

- **WHEN** the user clicks the usage button showing "42%"
- **THEN** a popover shows the conversation's cost, tokens, context meter and start time

#### Scenario: Window unknown

- **WHEN** opencode doesn't know the model's context window
- **THEN** the usage button shows the context tokens instead of a share

### Requirement: Side panel

The conversation view SHALL have a rail of icon buttons on its right edge, each with a tooltip. Each button SHALL open a side panel to the right of the transcript. Only one panel SHALL be open at a time. The panels SHALL be closed by default when a conversation first opens on a browser. Clicking the open panel's button, or the panel's close button, SHALL close it. The open panel SHALL be remembered on the browser. On narrow screens, the panel SHALL open as a sheet over the transcript. The panels SHALL be:

- **Turns**: the conversation's turns newest first, with the prompt, duration, usage, activity and model of each, and its changes on demand, as before.
- **Subagents**: the conversation's subagents with their cost, tokens and a link to open each in opencode. Its button SHALL be shown only when the conversation has subagents.

#### Scenario: Looking at a turn's changes

- **WHEN** the user clicks the Turns button and expands a turn's changes
- **THEN** the side panel shows that turn's changes, and the transcript stays visible beside it

#### Scenario: Closing the panel

- **WHEN** the Turns panel is open and the user clicks the Turns button again
- **THEN** the panel closes and the transcript takes the full width

#### Scenario: Switching panels

- **WHEN** the Turns panel is open and the user clicks the Subagents button
- **THEN** the Subagents panel replaces the Turns panel

#### Scenario: No subagents

- **WHEN** a conversation has no subagents
- **THEN** the rail has no Subagents button
