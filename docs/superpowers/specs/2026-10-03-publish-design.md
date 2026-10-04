# Publish: push and open a PR, forge-independent

Date: 2026-10-03
Status: Draft for review
Depends on: [review](2026-10-03-review-design.md). Publish is an action in the Review tab and
uses review's `ahead`/`dirty` state and base resolution.

## Problem

After review, the change has to reach the forge. This must not depend on `gh` or any other
forge CLI, and it should work with Forgejo natively.

Publishing has two parts: **push**, which is plain git, and **open the PR**, which is
forge-specific but usually just a URL.

## Where the push runs

On the host by default, whenever the checkout works there:

- The main checkout always does.
- A worktree does when it has a `hostPath` with relative links.

On the host, your own ssh-agent, credential helper and `~/.ssh/config` aliases apply, so
containers never need push credentials. Otherwise the push runs in the container.
`OPENDEVHUB_PUSH=host|container` forces one or the other.

One caveat: when the push runs on the host, `pre-push` hooks run there too. The push never
uses `--no-verify`.

## Forge detection

`git remote get-url <remote>` (default `origin`) is parsed into
`{ host, owner/repo path, webBase }`. It handles scp-style, `ssh://` (with a port) and `https`
URLs. The forge kind is decided by the first rule that matches:

1. `forges` in `config.json`. This also maps ssh host aliases to web hosts:
   `{ "git.example.com": { "kind": "forgejo", "web": "https://git.example.com" } }`
2. Well-known hosts: `github.com`, `gitlab.com`, `codeberg.org` (Forgejo), `bitbucket.org`.
3. A one-time unauthenticated probe of `https://<host>/api/forgejo/v1/version`, then
   `/api/v1/version` (Gitea). The result is cached in `config.json`.
4. Otherwise `unknown`.

## Strategies

| Kind | Default | What happens |
| --- | --- | --- |
| `forgejo` / `gitea` | `agit` | `git push <remote> HEAD:refs/for/<base> -o topic=<branch> -o title=<title> -o description=<desc>`. The push itself creates the pull request: no API token, no fork, no branch on the server. Publishing again uses the same topic, with `-o force-push=true` after a rebase. |
| `forgejo` / `gitea` | `branch` (opt-in) | Push the branch, then open `<web>/compare/<base>...<branch>`. Gitea and Forgejo can't prefill the title or body from URL parameters, so you type them on the forge. |
| `github` | `branch` | Push, then open `<web>/compare/<base>...<branch>?quick_pull=1&title=…&body=…`, with the body cut short to keep the URL under 8 KB. No `gh`, no token. |
| `gitlab` | `branch` | Push, then open `<web>/-/merge_requests/new?merge_request[source_branch]=…&merge_request[target_branch]=…&merge_request[title]=…&merge_request[description]=…` (prefill parameters not verified). |
| `bitbucket` | `branch` | Push, then open `<web>/pull-requests/new?source=<branch>&dest=<base>`. |
| `unknown` | `branch` | Push only. Any URL the remote prints is shown as a link. |

**Getting the PR link.** For every kind, the push output is scanned for `remote:` lines that
contain an `https://` URL. Forgejo, Gitea, GitLab and GitHub all print the new or existing
PR/MR URL there, so this works without knowing the forge.

The first matching URL is stored in `branch.<b>.opendevhubPr`, and the AGit topic in
`branch.<b>.opendevhubTopic`. The Review header then shows **View PR** and **Update PR**.

## Publish dialog

- **Title and description.** Prefilled by `generate` on the target's session ("Write a pull
  request title and a short description of this branch's changes"); you can edit both.
- **Also:** the remote (default `origin`), the target base, and the strategy (prefilled from
  the detected kind).
- **Enabled when** review reports `ahead > 0` and `!dirty`.

## AGit details to confirm during implementation

- **Multi-line descriptions.** Push options can't contain newlines. Forgejo accepts multi-line
  descriptions encoded as base64 (forgejo#8479); confirm the exact encoding against a Forgejo
  instance. Until then, send a one-line description and put the full text in the commit
  message body.
- **CI on AGit PRs.** The PR's head is `refs/pull/<n>/head`, not a branch. Forgejo Actions
  `pull_request` workflows should still run; confirm this in the Forgejo e2e test.
- **Base branches with `/`.** `refs/for/<base>` should work for these because the topic is
  passed separately with `-o topic`; this needs a test.
- **Merged or closed PRs.** Publishing again with the same topic then opens a new PR, so the
  dashboard clears the stored topic and URL and says so.

## Errors

- **Reporting.** Failures surface as the existing `CommandError`, on the Review tab and in the
  project log.
- **Rejected push.** A non-fast-forward rejection offers review's **Update from base**.
- **Force pushes** only ever use `--force-with-lease` (branch strategy) or `force-push=true`
  (AGit), and only after a rebase that opendevhub itself performed.

## Later

- **Forge APIs with tokens.** PR status, CI checks and review comments shown in the dashboard,
  and tasks created from issues. Forgejo first, through `/api/v1/repos/{o}/{r}/pulls`, with the
  token kept in the host's keychain or an env var. Nothing in this spec stores credentials.
- **GitLab `merge_request.*` push options,** which would do for GitLab what AGit does for
  Forgejo.

## Delivery

1. The `branch` strategy for all forge kinds.
2. Forgejo AGit.

## Testing

- **Unit:**
  - remote URL parsing (a table of scp, ssh-with-port, https and alias forms)
  - forge detection
  - compare-URL builders
  - the AGit command builder
  - parsing push output for URLs
- **e2e:** publish to a bare repo as `unknown`.
- **Opt-in e2e** (`OPENDEVHUB_E2E_FORGEJO=1`): start a Forgejo container, create a repo,
  publish with AGit and check the PR exists through Forgejo's API. Then publish again after a
  rebase and check there's still exactly one PR.

## Open questions

1. Should Forgejo default to `branch` instead of `agit` for people whose CI only runs on branch
   pushes?
