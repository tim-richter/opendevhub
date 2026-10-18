---
"opendevhub": patch
---

Fix several ways tasks, chats and cleanup could end up in the wrong state:

- Cleanup no longer offers a branch that never got a commit of its own as "merged", nor a branch or worktree a running session or a starting variant uses.
- A variant discarded by a pick while it was still starting stops there: it gets no container, session or first message.
- When the first message can't be confirmed (a timeout, or a restart while sending it), the variant or chat keeps running with a note to check the conversation, instead of showing as failed.
- Deleting an archived task deletes its conversations too, so they no longer come back as chats.
- A worktree that briefly looked missing keeps its record, creator and links when it shows up again.
- A `config.json` that isn't valid JSON stops opendevhub with an error instead of being replaced with defaults.
- A slow first message no longer holds up other git actions on the project.
- Closing a task conversation works for reviews and tasks made from a chat; a failed `opsx-propose` from Make task shows on the variant; a draft can't be started twice; only the latest pick counts; new worktrees take a free folder name when another branch's folder has theirs.
