---
"opendevhub": minor
---

Checks can be grouped: give checks the same `group` and the Checks panel shows them under one heading with a **Run group** button and a count of how many passed. Groups can be set in `devcontainer.json` or in the project's settings.

A check's timeout is no longer capped at 7200 seconds: any positive number of whole seconds works.

The checks editor shows groups as boxes you can add, rename and remove, and checks can be dragged (or moved with the arrow keys) to reorder them within and between groups. **Copy mine to team** opens the team's checks with your own merged in, to review and save to `devcontainer.json`.
