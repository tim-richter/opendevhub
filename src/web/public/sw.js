// opendevhub's service worker: shows the notices the server pushes, and answers permissions from
// the notification's buttons. Plain JavaScript, served as-is from public/.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let notice;
  try {
    notice = event.data.json();
  } catch {
    return;
  }
  const options = { body: notice.body, tag: notice.tag, data: notice, icon: "/favicon.svg" };
  if (notice.permission) {
    options.actions = [
      { action: "allow", title: "Allow once" },
      { action: "reject", title: "Reject" },
    ];
    options.requireInteraction = true;
  }
  event.waitUntil(self.registration.showNotification(notice.title, options));
});

async function answer(notice, decision) {
  let error;
  try {
    const res = await fetch(
      `/api/projects/${encodeURIComponent(notice.projectId)}/permissions/${encodeURIComponent(notice.permission.requestId)}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) },
    );
    if (res.ok) return;
    const body = await res.json().catch(() => ({}));
    error = body.error || `HTTP ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  // A click must never silently do nothing, e.g. for a request that was answered elsewhere.
  await self.registration.showNotification(`Couldn't answer: ${error}`, {
    body: notice.title,
    tag: `${notice.tag}:failed`,
    data: { ...notice, permission: undefined },
    icon: "/favicon.svg",
  });
}

async function open(notice) {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const client = windows.find((c) => new URL(c.url).origin === self.location.origin);
  if (client) {
    await client.focus();
    client.postMessage({ type: "open", projectId: notice.projectId, sessionId: notice.sessionId });
    return;
  }
  await self.clients.openWindow(notice.url || "/");
}

self.addEventListener("notificationclick", (event) => {
  const notice = event.notification.data || {};
  event.notification.close();
  if ((event.action === "allow" || event.action === "reject") && notice.permission) {
    event.waitUntil(answer(notice, event.action === "allow" ? "once" : "reject"));
    return;
  }
  event.waitUntil(open(notice));
});
