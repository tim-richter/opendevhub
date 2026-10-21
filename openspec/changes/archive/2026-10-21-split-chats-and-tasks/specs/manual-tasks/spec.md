## REMOVED Requirements

### Requirement: Every top-level session belongs to a task

**Reason**: A session that opendevhub did not start as a task variant is now a chat, not a task. **Migration**: See `chats` → "Sessions are chats unless a variant owns them". A migration turns existing manual tasks into chat rows.

### Requirement: Manual tasks for sessions opendevhub starts

**Reason**: Sessions opendevhub starts outside a task are recorded as chats. **Migration**: See `chats` → "Chats opendevhub starts".

### Requirement: Adopting sessions created elsewhere

**Reason**: Sessions found in opencode are adopted as chats with origin `opencode`. **Migration**: See `chats` → "Adopting sessions created elsewhere".

### Requirement: Manual task titles follow their session

**Reason**: Chat titles follow their session instead. Task titles never follow sessions. **Migration**: See `chats` → "Chat titles and removal".

### Requirement: Manual tasks in the dashboard

**Reason**: Chats are listed in the sidebar, on the project page and on checkout pages, not as tasks. **Migration**: See `chats` → "Chats in the snapshot" and "Recent chats in the sidebar".
