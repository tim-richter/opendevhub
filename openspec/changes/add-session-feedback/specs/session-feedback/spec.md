## ADDED Requirements

### Requirement: Feedback settings

The settings dialog SHALL have a Feedback section with:

- an on/off switch
- an endpoint URL
- an authentication mode: none, bearer token, or basic auth (username and password)
- a switch to ask for feedback automatically

The endpoint URL SHALL be HTTPS, or HTTP on a loopback host, with no credentials, query or fragment. The token or password SHALL be stored in the OS credential store and never sent back to the browser; the section SHALL only show whether one is saved. A "Send test" action SHALL post a test report to the endpoint and show whether it was accepted. Feedback SHALL be off until the user turns it on and saves an endpoint.

#### Scenario: Saving a bearer token

- **WHEN** the user saves `https://stats.example.com/feedback` with a bearer token
- **THEN** the URL is saved, the token goes to the OS credential store, and the section shows a token is saved without showing it

#### Scenario: Plain HTTP to a remote host

- **WHEN** the user enters `http://stats.example.com/feedback`
- **THEN** saving fails with a message that HTTP is allowed only on loopback

#### Scenario: Test send rejected

- **WHEN** the user clicks "Send test" and the endpoint answers 401
- **THEN** the section reports that the endpoint rejected the request with status 401

### Requirement: Feedback button

While feedback is on, a chat view and a task page SHALL offer a "Send feedback" button. On a task page it SHALL rate the variant being shown. It SHALL open a feedback dialog with:

- a score from 1 (bad) to 5 (good)
- an optional comment of up to 2000 characters
- a preview of the exact JSON that will be sent

Sending SHALL be disabled until a score is chosen. While feedback is off, the button SHALL NOT be shown.

#### Scenario: Rating a chat

- **WHEN** the user opens the feedback dialog on a chat, picks 4, writes "good plan, slow tests", and sends
- **THEN** opendevhub posts the chat's statistics with score 4 and that comment to the endpoint

#### Scenario: Feedback off

- **WHEN** feedback is off in settings
- **THEN** no chat or task shows the "Send feedback" button, and nothing is ever posted

### Requirement: Asking at the end

While feedback and automatic asking are on, opendevhub SHALL open the feedback dialog when the user archives a chat or ends a task, unless that chat or variant already has feedback. The user SHALL be able to dismiss it without sending. A dismissal SHALL NOT stop the user from rating the chat or variant later with the button.

#### Scenario: Archiving a chat

- **WHEN** the user archives a chat that has no feedback yet
- **THEN** the chat is archived and the feedback dialog opens for it

#### Scenario: Already rated

- **WHEN** the user ends a task whose shown variant was already rated
- **THEN** no feedback dialog opens

### Requirement: Stored and delivered once

opendevhub SHALL store each submitted feedback locally with:

- its chat or variant
- its session
- its score and comment
- the exact payload
- when it was submitted
- its delivery state: pending, sent, or failed with the error

It SHALL POST the payload as JSON with the configured authentication header, and treat a 2xx answer as sent. A chat or variant SHALL have at most one feedback; the dialog for one that has feedback SHALL show the stored score and state instead of asking again. A failed feedback SHALL offer "Resend", which posts the stored payload again.

#### Scenario: Endpoint down

- **WHEN** the user sends feedback and the endpoint can't be reached
- **THEN** the feedback is stored as failed with the error, and the dialog offers "Resend"

#### Scenario: Resend succeeds

- **WHEN** the user clicks "Resend" on a failed feedback and the endpoint answers 201
- **THEN** the same payload is posted and the feedback is marked sent

### Requirement: Report format

The posted JSON SHALL hold:

- a `schemaVersion`
- a random report id
- the opendevhub version
- the submission time
- the score and comment
- the statistics summary from session-statistics

The report SHALL NOT include the opencode session id, chat id or task id, which could be traced back to local data. It SHALL instead carry the random report id, which stays the same across resends so the receiver can deduplicate.

#### Scenario: Deduplicating a resend

- **WHEN** a feedback is resent after a timeout that the endpoint had in fact received
- **THEN** both posts carry the same report id
