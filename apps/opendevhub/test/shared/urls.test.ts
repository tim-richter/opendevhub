import { describe, expect, it } from "vitest";

import { enterUrl, sessionUrl, taskHref } from "../../src/shared/urls";

describe(sessionUrl, () => {
  it("builds opencode's per-session route for the project origin", () => {
    const base = "http://demo-abc123.localhost:7777/";
    const key = Buffer.from("http://demo-abc123.localhost:7777").toString(
      "base64url"
    );
    expect(sessionUrl(base, "ses_1")).toBe(
      `http://demo-abc123.localhost:7777/server/${key}/session/ses_1`
    );
  });
});

describe(enterUrl, () => {
  it("routes an environment host's page through the dashboard's enter route", () => {
    expect(
      enterUrl("http://demo-abc123.localhost:7777/server/k/session/s?x=1")
    ).toBe(
      `/api/envs/demo-abc123/enter?next=${encodeURIComponent("/server/k/session/s?x=1")}`
    );
  });

  it("leaves other URLs alone", () => {
    expect(enterUrl("https://git.example.com/pr/1")).toBe(
      "https://git.example.com/pr/1"
    );
    expect(enterUrl("/p/app")).toBe("/p/app");
  });
});

describe(taskHref, () => {
  it("is the Conversation tab without options", () => {
    expect(taskHref("app", "abc")).toBe("/p/app/t/abc");
    expect(taskHref("app", "abc", { tab: "conversation" })).toBe(
      "/p/app/t/abc"
    );
  });

  it("adds the tab, variant and thread", () => {
    expect(taskHref("app", "abc", { tab: "terminal", v: 2 })).toBe(
      "/p/app/t/abc/terminal?v=2"
    );
    expect(taskHref("app", "abc", { thread: "ses_9", v: 1 })).toBe(
      "/p/app/t/abc?v=1&thread=ses_9"
    );
  });

  it("encodes ids", () => {
    expect(taskHref("my app", "a/b")).toBe("/p/my%20app/t/a%2Fb");
  });
});
