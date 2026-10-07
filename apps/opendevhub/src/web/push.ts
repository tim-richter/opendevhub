// The page's half of Web Push: register the service worker, subscribe with the server's VAPID key
// and hand the subscription to the server, which pushes notices even while no tab is open.

export const pushSupported = (): boolean =>
  typeof Notification !== "undefined" &&
  "serviceWorker" in navigator &&
  typeof PushManager !== "undefined";

const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
};

const sameKey = (a: ArrayBuffer | null, b: Uint8Array): boolean => {
  if (!a || a.byteLength !== b.length) {
    return false;
  }
  const view = new Uint8Array(a);
  return view.every((byte, i) => byte === b[i]);
};

const post = async (route: string, body: unknown): Promise<Response> => {
  const res = await fetch(route, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `${route} failed (${res.status})`);
  }
  return res;
};

/** Registers the worker and makes sure this browser is subscribed with the server's current key. */
const subscribe = async (): Promise<void> => {
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const res = await fetch("/api/push/key");
  if (!res.ok) {
    throw new Error(`push key failed (${res.status})`);
  }
  const key = base64UrlToBytes(
    ((await res.json()) as { publicKey: string }).publicKey
  );

  let subscription = await registration.pushManager.getSubscription();
  // A subscription made with other keys (push.json was lost or regenerated) can't receive our pushes.
  if (
    subscription &&
    !sameKey(subscription.options.applicationServerKey, key)
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    applicationServerKey: key,
    userVisibleOnly: true,
  });
  await post("/api/push/subscribe", subscription.toJSON());
};

/** Asks for notification permission, then subscribes. Resolves to the permission the user chose. */
export const enablePush = async (): Promise<NotificationPermission> => {
  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    await subscribe();
  }
  return permission;
};

/** On load with permission granted: subscribe again if needed, so pushes keep arriving without a click. */
export const syncPush = async (): Promise<void> => {
  if (!pushSupported() || Notification.permission !== "granted") {
    return;
  }
  await subscribe();
};

/** Closes the worker's notifications whose tags `stale` picks. */
export const closeNotifications = async (
  stale: (tags: string[]) => string[]
): Promise<void> => {
  if (!pushSupported()) {
    return;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    return;
  }
  const shown = await registration.getNotifications();
  const close = new Set(stale(shown.map((n) => n.tag)));
  for (const n of shown) {
    if (close.has(n.tag)) {
      n.close();
    }
  }
};

export const sendTestNotification = async (): Promise<number> => {
  const res = await post("/api/push/test", {});
  return ((await res.json()) as { sent: number }).sent;
};
