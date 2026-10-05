# Push notifications: reach you when the dashboard tab is closed

Date: 2026-10-05
Status: Draft for review
Backlog item: "Notifications that reach you when the dashboard tab is closed" (the Web Push half).

## Problem

The dashboard's notifications come from `new Notification(...)` in `src/web/useDashboard.ts`,
driven by `diffForNotifications` comparing snapshots in the page. They only fire while a dashboard
tab is open. Close the tab and an agent can wait on a permission for an hour without you knowing.
Answering a permission is usually one click, so the notification should offer that click.

## Scope

In:

- Notifications on **this computer** with the dashboard tab closed (the browser still running),
  through Web Push and a service worker.
- **Allow once / Reject** buttons on permission notifications (Chromium browsers; others get the
  notification without buttons).
- Notices computed on the server, one per pending permission or question, plus "finished".

Out: notifications on a phone, webhooks (ntfy, Pushover, Slack, generic URL) and remote access.
They stay in the backlog. Answering questions (forms) from a notification, "Allow always" from a
notification, and per-project or per-event notification settings.

### Success criteria

- With the tab closed and Chrome running, a new permission request shows a notification within a
  few seconds; **Allow once** resolves it without opening the dashboard.
- A second permission in a session that is already waiting gets its own notification.
- Clicking a notification's body focuses an open dashboard tab on the session, or opens one.
- An open tab shows each notice once, not twice.
- When the push service is unreachable, the dashboard keeps working and the log says why
  notifications aren't arriving.

## Background: Web Push

A closed tab can only be woken by Web Push: the server sends an encrypted message to the browser
vendor's push service (Google's for Chrome, Edge and Brave; Mozilla's for Firefox; Apple's for
Safari), which delivers it to the browser's service worker. The payload is end-to-end encrypted,
but opendevhub needs outbound internet access to the push service. Service workers need a secure
context; `http://localhost` counts as one.

Notification action buttons are supported in Chromium (up to two), not in Firefox or Safari on
macOS. Chrome requires every push to show a visible notification (`userVisibleOnly`), so pushes
can't be used to silently close notifications.

A push subscription belongs to an origin: `localhost:7777`, `127.0.0.1:7777` and another port are
separate subscriptions.

## Server

### Notices (`src/shared/notices.ts`)

`diffForNotifications` and `pendingSummary` move from `src/web/derive.ts` to
`src/shared/notices.ts` (the web keeps importing `pendingSummary` from there). The diff changes
from per status change to per pending item:

```ts
interface Notice {
  tag: string;        // notification tag: a re-sent notice replaces the old notification
  title: string;
  body: string;
  url: string;        // dashboard path: /p/<projectId>?session=<sessionId>
  projectId: string;
  sessionId: string;
  permission?: { requestId: string }; // present: the notification gets Allow once / Reject
}
```

- **Permission:** each permission id in a session's `pending.permissions` that was not pending in
  the previous snapshot. Tag `perm:<id>`. Title `<project> · wants <action>: <first resource>`
  (the existing wording, for that permission rather than the session's first), body the session
  title.
- **Question:** each form id in `pending.forms` that is new. Tag `form:<id>`. Title
  `<project> · asks: <form title>`.
- **Finished:** a root session going from `running` to `idle`. Tag `done:<sessionId>`. Title
  `<project>: finished`.
- No previous snapshot (the first after startup): no notices. Items already waiting at startup
  don't notify, as today.

### Notifier (`src/server/notifier.ts`)

Subscribes to the store (`store.subscribe`), keeps the previous snapshot, runs the diff on each
change and hands each notice to `Push.send`. Kept apart from `push.ts` so the diff wiring and the
delivery are tested separately.

### Push (`src/server/push.ts`)

- `push.json` in the state directory (`~/.local/state/opendevhub/push.json`, mode `0600`, like
  `state.json`): `{ vapid: { publicKey, privateKey }, subscriptions: PushSubscriptionJSON[] }`.
- On first use, generate a VAPID key pair. The VAPID subject is `mailto:opendevhub@localhost`.
- `send(notice)`: sends the notice as JSON to every subscription, with `TTL: 900` (15 minutes; a
  notice that waited in the push service while the laptop slept is probably stale) and
  `urgency: "high"` for permissions and questions, `"normal"` for finished.
- A `404` or `410` from the push service: the subscription is gone; remove it and save.
- Any other failure: log `push: could not reach <push service host> (<reason>)` once per stretch
  of failures, and `push: delivering again` when a send succeeds afterwards. No queue, no retries.
- `push.json` unreadable or invalid: log `push: push.json is invalid; starting with new keys`,
  generate new keys and start with no subscriptions. Open tabs see a different public key and
  subscribe again on their next load.
- The sender is a dependency (`sendNotification(subscription, payload, options)`), defaulting to
  the `web-push` package. Tests inject a fake.

New runtime dependency: `web-push` (VAPID signing and `aes128gcm` payload encryption). Writing
this on `node:crypto` is possible but easy to get subtly wrong.

### Routes (`dashboard-api.ts`)

| Route | Body | Does |
| --- | --- | --- |
| `GET /api/push/key` | | `{ publicKey }` (base64url) |
| `POST /api/push/subscribe` | a `PushSubscriptionJSON` | Adds it, replacing any with the same `endpoint`. `400` without `endpoint` and `keys.p256dh`/`keys.auth`. |
| `POST /api/push/unsubscribe` | `{ endpoint }` | Removes it. |
| `POST /api/push/test` | | Sends `{ tag: "test", title: "opendevhub", body: "Notifications work.", url: "/" }` to every subscription; `{ sent: n }`. |

Permission replies from a notification use the existing
`POST /api/projects/:id/permissions/:rid` with `{ decision: "once" | "reject" }`.

## Web

### Service worker (`src/web/public/sw.js`)

Plain JavaScript, no build step. Vite copies `public/` into the build and the existing static route
serves `.js` as `text/javascript`.

- `push`: parse the notice and `showNotification(title, { body, tag, data: notice, ... })`.
  Permission notices add `actions: [{ action: "allow", title: "Allow once" }, { action: "reject",
  title: "Reject" }]` and `requireInteraction: true`. Questions and finished notices don't
  require interaction.
- `notificationclick` with `allow` or `reject`: close the notification and POST the decision. The
  dashboard isn't opened. On a non-2xx response or a network error, show a notification
  `Couldn't answer: <error message from the response, or the network error>` with tag
  `<tag>:failed`, so a click never silently does nothing (an already answered request lands here).
- `notificationclick` on the body: close it, then focus an open dashboard client and
  `postMessage({ type: "open", projectId, sessionId })` to it, or `clients.openWindow(url)` when
  none is open.

### Page

- `src/web/push.ts`:
  - `enablePush()`: `Notification.requestPermission()`, register `/sw.js`, fetch the public key,
    `pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` and POST the
    subscription.
  - `syncPush()`: on load with permission `granted`, register the worker. If there's an existing
    subscription with a different `applicationServerKey` than the server's, unsubscribe it. Then
    subscribe if needed and POST the subscription. This moves existing users over without a click
    and recovers from a lost `push.json`.
- `DashboardContext`:
  - The `requestPermission` it exposes calls `enablePush()`.
  - `permission` is `"unsupported"` without `serviceWorker` or `PushManager` as well as without
    `Notification`. The sidebar's "Enable notifications" item in `Shell.tsx` stays as it is: shown
    while permission is `"default"`.
  - A `message` listener on `navigator.serviceWorker` turns `{ type: "open" }` into the existing
    `highlight` → `navigate` flow.
- `useDashboard`: drops `showNotification` and its call to `diffForNotifications`. On each snapshot
  it calls `staleNotificationTags(snapshot, tags)` (a pure function in `derive.ts`) on the worker's
  `getNotifications()` and closes those: `perm:` and `form:` tags whose item is no longer pending.
  Without an open tab, an answered item's notification stays until clicked (the click reports
  that it couldn't answer).
- `⌘K`: a **Send test notification** entry that calls `POST /api/push/test`, shown when
  permission is `granted`. With `sent: 0` it reports "No browser is subscribed".

## Error handling

- Push service unreachable: logged as above. The dashboard and open tabs are unaffected, but an
  open tab no longer shows notifications either (there's no in-page path any more).
- No subscriptions: notices are computed and dropped.
- `push.json` invalid: new keys, as above.
- A browser without service workers or `PushManager`: no "Enable notifications" item.
- A notification action for a permission that was answered elsewhere, or a project that's gone:
  the route's error comes back and the worker shows it.

## Testing

Unit (server):

- Notices: a new permission while another is pending in the same session, a new form, running to
  idle, idle to running (nothing), the first snapshot (nothing), an item disappearing (nothing),
  and a subagent's permission rolling up to its root session's URL.
- `push.ts` with a fake sender and a temp state dir: sends to every subscription with TTL and
  urgency, removes a subscription on `404` and `410`, logs one failure line per stretch and one
  recovery line, keeps keys across a reload, regenerates on an invalid file, and replaces a
  subscription with the same endpoint.
- Routes: key, subscribe (including `400`), unsubscribe, test.

Unit (web): `staleNotificationTags` for answered permissions, answered forms, and `done:` and
`test` tags (never closed).

E2E (existing harness, fake sender injected through deps): create a real pending permission
through opencode's `POST /api/session/:sid/permission`, check one notice is sent with
`permission.requestId`, POST `{ decision: "once" }` to the reply route as the worker does, and check
the permission is resolved.

Manual, with the `run` skill and Chrome: enable, test notification, Allow once and Reject with the
tab closed, clicking the body with and without an open tab, and the cleanup when answering in the
dashboard. There's no Chromium in the automated tests, so the service worker is only checked here.

## Docs

- README: a **Notifications** section. What notifies, that the browser must be running, that it
  needs internet access to the browser vendor's push service, that the buttons are Chromium only,
  and that a different host or port means enabling them again. The feature list's "sends browser
  notifications" line links to it.
- Backlog: the notifications item keeps only the webhooks (ntfy, Pushover, Slack, generic URL),
  for the phone case, next to remote access.
