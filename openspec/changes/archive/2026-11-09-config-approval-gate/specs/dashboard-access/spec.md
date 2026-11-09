## Purpose

Lets only the user's browser use the dashboard: processes that can reach the server's port, agents in containers among them, can't call its API, read its stream or drive an environment's opencode without the access token.

## ADDED Requirements

### Requirement: Access token

opendevhub SHALL keep one random access token of at least 128 bits in an owner-only file in its state folder, create it when missing and keep it across restarts. The token SHALL never be sent to a container, written to a project's files or included in the dashboard snapshot.

#### Scenario: Token kept across restarts

- **WHEN** opendevhub starts, stops and starts again
- **THEN** both runs use the same token, read from the state folder

#### Scenario: Token file permissions

- **WHEN** opendevhub creates the token file
- **THEN** only the file's owner can read or write it

### Requirement: Opening the dashboard with the token

When it starts, the CLI SHALL print the dashboard URL with the token as a query parameter and open that URL unless `--no-open` is given. `opendevhub open` SHALL print and open the same URL for a server that is already running, a service included. A request for a dashboard page carrying the correct token SHALL set the access cookie and redirect to the same page without the token.

#### Scenario: First visit

- **WHEN** the browser opens `http://localhost:7777/?token=<token>`
- **THEN** the response sets the access cookie and redirects to `http://localhost:7777/`

#### Scenario: Wrong token

- **WHEN** the browser opens the dashboard with a token that doesn't match
- **THEN** no cookie is set and the page explains how to open the dashboard with its link

#### Scenario: Running as a service

- **WHEN** opendevhub runs as a login service and the user runs `opendevhub open`
- **THEN** the browser opens the dashboard with the token

### Requirement: Access cookie

The access cookie SHALL be HttpOnly, SameSite=Strict, scoped to the host it was set on, and valid for a year. It SHALL hold a value derived from the token, not the token itself, so that it is useless once the token is replaced.

#### Scenario: Cookie attributes

- **WHEN** the server sets the access cookie
- **THEN** the cookie is HttpOnly and SameSite=Strict, has no Domain attribute, and expires after a year

### Requirement: Protected routes

Every `/api` request, the event stream and the terminal socket SHALL require the access cookie, and SHALL answer 401 without it. Dashboard pages and their static files SHALL be served without it, so the page can explain how to get access.

#### Scenario: API call from a container

- **WHEN** a process in a container sends `POST /api/projects/demo/tasks` to the server with `Host: localhost:7777` and no cookie
- **THEN** the server answers 401 and starts nothing

#### Scenario: Event stream without access

- **WHEN** a request opens `/api/events` without the cookie
- **THEN** the server answers 401 and sends no snapshot

#### Scenario: Page without access

- **WHEN** the browser loads the dashboard without the cookie
- **THEN** the page loads and shows how to open the dashboard with its link, instead of the dashboard

### Requirement: Environment proxy access

Requests to an environment's host (`<env>.localhost`) SHALL require that host's own access cookie. The dashboard SHALL open an environment through the server, which hands out a one-time code valid for one minute. The environment host SHALL exchange the code for its cookie and redirect to its root. The cookie SHALL NOT be valid on any other host.

#### Scenario: Opening an environment's opencode

- **WHEN** the user opens a worktree's opencode from the dashboard
- **THEN** the browser lands on the environment's host with its cookie set and sees opencode

#### Scenario: Another container calls an environment

- **WHEN** a process in one container sends a request with `Host: <other-env>.localhost:7777` and no cookie
- **THEN** the server answers 401 and the request never reaches that environment's opencode

#### Scenario: Reused code

- **WHEN** a one-time code is used a second time, or after a minute
- **THEN** no cookie is set and the request is refused

### Requirement: Replacing the token

`opendevhub token --reset` SHALL replace the token. Every browser and environment cookie issued for the old token SHALL then be refused, and the CLI SHALL print the new link.

#### Scenario: Reset

- **WHEN** the user runs `opendevhub token --reset` and reloads a dashboard tab
- **THEN** the tab shows how to open the dashboard with its link, and the new link from the CLI opens it again
