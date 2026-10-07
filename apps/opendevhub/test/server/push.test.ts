import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { InvalidSubscriptionError, Push } from "../../src/server/push";
import type { PushSender } from "../../src/server/push";
import type { Notice } from "../../src/shared/notices";

const sub = (n: number) => ({
  endpoint: `https://push.example.com/send/${n}`,
  keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` },
});

const permNotice: Notice = {
  tag: "perm:r1",
  title: "demo · wants bash: npm test",
  body: "T a",
  url: "/p/p?session=a",
  projectId: "p",
  sessionId: "a",
  permission: { requestId: "r1" },
};

function setup(sender?: PushSender) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-push-"));
  const file = path.join(dir, "push.json");
  const send = vi.fn<PushSender>(sender ?? (async () => ({ statusCode: 201 })));
  const log = vi.fn<(line: string) => void>();
  const make = () => new Push({ file, send, log });
  return { file, send, log, make, push: make() };
}

const gone = (statusCode: number) =>
  Object.assign(new Error(`Received unexpected response code`), { statusCode });

describe(Push, () => {
  it("generates VAPID keys once and keeps them across a reload, in a 0600 file", () => {
    const { push, make, file } = setup();
    const key = push.publicKey();
    expect(key).toMatch(/^[A-Za-z0-9_-]{80,}$/u);
    expect(make().publicKey()).toBe(key);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(
      JSON.parse(fs.readFileSync(file, "utf-8")).vapid.privateKey
    ).toBeTruthy();
  });

  it("starts with new keys and no subscriptions when push.json is invalid", () => {
    const { file, make, log } = setup();
    fs.writeFileSync(file, "{ not json");
    const push = make();
    expect(push.publicKey()).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(log).toHaveBeenCalledWith(
      "push: push.json is invalid; starting with new keys"
    );
    expect(push.subscriptions()).toStrictEqual([]);

    fs.writeFileSync(
      file,
      JSON.stringify({ vapid: { publicKey: 1 }, subscriptions: [] })
    );
    make().publicKey();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("subscribes, replacing one with the same endpoint, and unsubscribes", () => {
    const { push, make } = setup();
    push.subscribe(sub(1));
    push.subscribe(sub(2));
    push.subscribe({ ...sub(1), keys: { p256dh: "new", auth: "new" } });
    expect(
      make()
        .subscriptions()
        .map((s) => [s.endpoint, s.keys.p256dh])
    ).toStrictEqual([
      [sub(2).endpoint, "p256dh-2"],
      [sub(1).endpoint, "new"],
    ]);
    push.unsubscribe(sub(2).endpoint);
    expect(
      make()
        .subscriptions()
        .map((s) => s.endpoint)
    ).toStrictEqual([sub(1).endpoint]);
  });

  it("rejects a subscription without an https endpoint or keys", () => {
    const { push } = setup();
    expect(() => push.subscribe({})).toThrow(InvalidSubscriptionError);
    expect(() =>
      push.subscribe({ endpoint: "https://x", keys: { p256dh: "a" } })
    ).toThrow(InvalidSubscriptionError);
    expect(() =>
      push.subscribe({ ...sub(1), endpoint: "http://127.0.0.1:22/" })
    ).toThrow(InvalidSubscriptionError);
    expect(push.subscriptions()).toStrictEqual([]);
  });

  it("sends the notice as JSON to every subscription with TTL, urgency and VAPID details", async () => {
    const { push, send } = setup();
    push.subscribe(sub(1));
    push.subscribe(sub(2));
    await expect(push.send(permNotice)).resolves.toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    const [subscription, payload, options] = send.mock.calls[0];
    expect(subscription).toStrictEqual(sub(1));
    expect(JSON.parse(payload)).toStrictEqual(permNotice);
    expect(options).toMatchObject({
      TTL: 900,
      urgency: "high",
      vapidDetails: {
        subject: "mailto:opendevhub@localhost",
        publicKey: push.publicKey(),
      },
    });

    await push.send({ ...permNotice, tag: "form:f1", permission: undefined });
    expect(send.mock.calls[2][2]).toMatchObject({ urgency: "high" });
    await push.send({
      tag: "done:a",
      title: "demo: finished",
      body: "T a",
      url: "/",
    });
    expect(send.mock.calls[4][2]).toMatchObject({ urgency: "normal" });
  });

  it("removes a subscription the push service says is gone (404, 410)", async () => {
    const { push, make, send } = setup();
    for (const n of [1, 2, 3]) {
      push.subscribe(sub(n));
    }
    send.mockImplementation(async (s) => {
      if (s.endpoint.endsWith("/1")) {
        throw gone(410);
      }
      if (s.endpoint.endsWith("/2")) {
        throw gone(404);
      }
      return { statusCode: 201 };
    });
    await expect(push.send(permNotice)).resolves.toBe(1);
    expect(
      make()
        .subscriptions()
        .map((s) => s.endpoint)
    ).toStrictEqual([sub(3).endpoint]);
  });

  it("logs one line per stretch of failures and one when delivery recovers", async () => {
    const { push, send, log } = setup();
    push.subscribe(sub(1));
    send.mockRejectedValue(
      Object.assign(new Error("getaddrinfo ENOTFOUND push.example.com"), {
        code: "ENOTFOUND",
      })
    );
    await expect(push.send(permNotice)).resolves.toBe(0);
    await push.send(permNotice);
    expect(log.mock.calls).toStrictEqual([
      [
        "push: could not reach push.example.com (getaddrinfo ENOTFOUND push.example.com)",
      ],
    ]);

    send.mockResolvedValue({ statusCode: 201 });
    await push.send(permNotice);
    await push.send(permNotice);
    expect(log.mock.calls.slice(1)).toStrictEqual([["push: delivering again"]]);

    send.mockRejectedValue(gone(500));
    await push.send(permNotice);
    expect(log.mock.calls.slice(2)).toStrictEqual([
      ["push: could not reach push.example.com (HTTP 500)"],
    ]);
    expect(push.subscriptions()).toHaveLength(1);
  });

  it("sends nothing without subscriptions", async () => {
    const { push, send } = setup();
    await expect(push.send(permNotice)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
