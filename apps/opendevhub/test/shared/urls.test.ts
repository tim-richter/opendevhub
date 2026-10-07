import { describe, expect, it } from "vitest";

import { sessionUrl } from "../../src/shared/urls";

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
