import fs from "node:fs";

import webpush from "web-push";

import type { Notice } from "../shared/notices";
import { writeJson } from "./config";

export interface Subscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PushFile {
  vapid: VapidKeys;
  subscriptions: Subscription[];
}

/** What a push carries: a notice, or the test notification. */
export type PushMessage = Pick<Notice, "tag" | "title" | "body" | "url"> &
  Partial<Notice>;

export interface SendOptions {
  TTL: number;
  urgency: "high" | "normal";
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
}

/** `web-push`'s sendNotification, narrowed to what we use; rejects with `statusCode` for a non-2xx answer. */
export type PushSender = (
  subscription: Subscription,
  payload: string,
  options: SendOptions
) => Promise<{ statusCode: number }>;

export class InvalidSubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSubscriptionError";
  }
}

const SUBJECT = "mailto:opendevhub@localhost";
/** A notice that waited in the push service while the laptop slept is probably stale. */
const TTL = 900;

const str = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const parseSubscription = (raw: unknown): Subscription => {
  const s = (raw ?? {}) as {
    endpoint?: unknown;
    keys?: { p256dh?: unknown; auth?: unknown };
  };
  if (!str(s.endpoint)) {
    throw new InvalidSubscriptionError("subscription needs an endpoint");
  }
  let url: URL;
  try {
    url = new URL(s.endpoint);
  } catch {
    throw new InvalidSubscriptionError("subscription endpoint is not a URL");
  }
  // Push services are https; anything else would make the server POST to arbitrary local addresses.
  if (url.protocol !== "https:") {
    throw new InvalidSubscriptionError("subscription endpoint must be https");
  }
  if (!str(s.keys?.p256dh) || !str(s.keys?.auth)) {
    throw new InvalidSubscriptionError(
      "subscription needs keys.p256dh and keys.auth"
    );
  }
  return {
    endpoint: s.endpoint,
    keys: { auth: s.keys.auth, p256dh: s.keys.p256dh },
  };
};

const parseFile = (text: string): PushFile | undefined => {
  try {
    const raw = JSON.parse(text) as Partial<PushFile>;
    if (
      !str(raw.vapid?.publicKey) ||
      !str(raw.vapid?.privateKey) ||
      !Array.isArray(raw.subscriptions)
    ) {
      return undefined;
    }
    const subscriptions = raw.subscriptions.flatMap((s) => {
      try {
        return [parseSubscription(s)];
      } catch {
        return [];
      }
    });
    return {
      subscriptions,
      vapid: {
        privateKey: raw.vapid.privateKey,
        publicKey: raw.vapid.publicKey,
      },
    };
  } catch {
    return undefined;
  }
};

/** Web Push delivery: VAPID keys and browser subscriptions in `push.json`, one send per subscription. */
export class Push {
  private data?: PushFile;
  private failing = false;
  private readonly sendFn: PushSender;
  private readonly log: (line: string) => void;

  private readonly opts: {
    file: string;
    send?: PushSender;
    log?: (line: string) => void;
  };
  constructor(opts: {
    file: string;
    send?: PushSender;
    log?: (line: string) => void;
  }) {
    this.opts = opts;
    this.sendFn =
      opts.send ??
      ((sub, payload, options) =>
        webpush.sendNotification(sub, payload, options));
    this.log = opts.log ?? ((line) => console.warn(line));
  }

  publicKey(): string {
    return this.load().vapid.publicKey;
  }

  subscriptions(): Subscription[] {
    return [...this.load().subscriptions];
  }

  /** Adds a browser's subscription, replacing any with the same endpoint. */
  subscribe(raw: unknown): void {
    const sub = parseSubscription(raw);
    const data = this.load();
    data.subscriptions = [
      ...data.subscriptions.filter((s) => s.endpoint !== sub.endpoint),
      sub,
    ];
    this.save();
  }

  unsubscribe(endpoint: string): void {
    const data = this.load();
    const kept = data.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (kept.length === data.subscriptions.length) {
      return;
    }
    data.subscriptions = kept;
    this.save();
  }

  /** Sends to every subscription; resolves to how many accepted it. Never rejects. */
  async send(message: PushMessage): Promise<number> {
    const data = this.load();
    const subs = data.subscriptions;
    if (subs.length === 0) {
      return 0;
    }
    const options: SendOptions = {
      TTL,
      urgency: /^(?<g1>perm|form):/u.test(message.tag) ? "high" : "normal",
      vapidDetails: { subject: SUBJECT, ...data.vapid },
    };
    const payload = JSON.stringify(message);
    const results = await Promise.allSettled(
      subs.map((s) => this.sendFn(s, payload, options))
    );

    const gone = new Set<string>();
    let sent = 0;
    let failure: { host: string; reason: string } | undefined;
    for (const [i, r] of results.entries()) {
      if (r.status === "fulfilled") {
        sent += 1;
        continue;
      }
      const err = r.reason as { statusCode?: number; message?: string };
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        gone.add(subs[i].endpoint);
        continue;
      }
      failure ??= {
        host: new URL(subs[i].endpoint).host,
        reason: err?.statusCode
          ? `HTTP ${err.statusCode}`
          : (err?.message ?? String(r.reason)),
      };
    }

    if (gone.size > 0) {
      data.subscriptions = data.subscriptions.filter(
        (s) => !gone.has(s.endpoint)
      );
      this.save();
    }
    if (failure && !this.failing) {
      this.failing = true;
      this.log(`push: could not reach ${failure.host} (${failure.reason})`);
    } else if (!failure && sent > 0 && this.failing) {
      this.failing = false;
      this.log("push: delivering again");
    }
    return sent;
  }

  private load(): PushFile {
    if (this.data) {
      return this.data;
    }
    let text: string | undefined;
    try {
      text = fs.readFileSync(this.opts.file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    let data = text === undefined ? undefined : parseFile(text);
    if (text !== undefined && !data) {
      this.log("push: push.json is invalid; starting with new keys");
    }
    if (!data) {
      data = { subscriptions: [], vapid: webpush.generateVAPIDKeys() };
      this.data = data;
      this.save();
    }
    this.data = data;
    return data;
  }

  private save(): void {
    writeJson(this.opts.file, this.data, 0o600);
  }
}
