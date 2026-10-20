---
"opendevhub": minor
---

**After upgrading, open the dashboard once with its link.** opendevhub now keeps an access token and prints the dashboard link with it (`http://localhost:7777/?token=…`); `opendevhub open` prints and opens it again, a login service included, and `opendevhub token --reset` replaces it. Without the link's cookie the API, live updates, terminals and environments' opencode answer 401, so processes in containers can't use the dashboard. A bookmarked `http://localhost:7777/` shows how to get access.

Devcontainer settings that act on the host (`initializeCommand`, mounts, `runArgs`, `privileged`, `capAdd`, `securityOpt`, `appPort`, a build context outside the repository, Docker Compose files, including what features add) now need your approval before a container is built or started from them. The project and the worktree show a banner to review the change, approve it or keep the container stopped; task variants wait at **Needs approval**. Approvals apply to the whole project. Projects whose config has such settings ask once, on their next start.
