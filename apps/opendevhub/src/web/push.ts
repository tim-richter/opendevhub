import { api, complete, read } from "./rpc";

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

/** Registers the worker and makes sure this browser is subscribed with the server's current key. */
const subscribe = async (): Promise<void> => {
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { publicKey } = await read(api.push.key.$get(), "push key");
  const key = base64UrlToBytes(publicKey);

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
  await complete(
    api.push.subscribe.$post({ json: subscription.toJSON() }),
    "subscribe to notifications"
  );
};

/** Set while this browser has turned notifications off in Settings, so loading the page doesn't subscribe it again. */
const OFF_KEY = "opendevhub.notifications.off";

const turnedOff = (): boolean => {
  try {
    return localStorage.getItem(OFF_KEY) === "1";
  } catch {
    return false;
  }
};

const setTurnedOff = (off: boolean): void => {
  try {
    if (off) {
      localStorage.setItem(OFF_KEY, "1");
    } else {
      localStorage.removeItem(OFF_KEY);
    }
  } catch {
    // Without storage the choice lasts until the next page load.
  }
};

/** Asks for notification permission, then subscribes. Resolves to the permission the user chose. */
export const enablePush = async (): Promise<NotificationPermission> => {
  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    setTurnedOff(false);
    await subscribe();
  }
  return permission;
};

/** Unsubscribes this browser; permission stays granted, so turning notifications back on needs no prompt. */
export const disablePush = async (): Promise<void> => {
  setTurnedOff(true);
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) {
    return;
  }
  const { endpoint } = subscription;
  await subscription.unsubscribe();
  await complete(
    api.push.unsubscribe.$post({ json: { endpoint } }),
    "unsubscribe from notifications"
  );
};

/** Whether this browser receives notifications: permission granted, not turned off, and subscribed. */
export const pushEnabled = async (): Promise<boolean> => {
  if (
    !pushSupported() ||
    Notification.permission !== "granted" ||
    turnedOff()
  ) {
    return false;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  return !!(await registration?.pushManager.getSubscription());
};

/** On load with permission granted: subscribe again if needed, so pushes keep arriving without a click. */
export const syncPush = async (): Promise<void> => {
  if (
    !pushSupported() ||
    Notification.permission !== "granted" ||
    turnedOff()
  ) {
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
  const { sent } = await read(api.push.test.$post(), "test notification");
  return sent;
};
