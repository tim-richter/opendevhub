import { describe, expect, it } from "vitest";
import { classifyHost } from "../../src/server/hosts";

describe("classifyHost", () => {
  it.each([
    ["localhost:7777", { kind: "dashboard" }],
    ["127.0.0.1:7777", { kind: "dashboard" }],
    ["LOCALHOST:7777", { kind: "dashboard" }],
    ["demo-abc123.localhost:7777", { kind: "env", envId: "demo-abc123" }],
    ["Demo-ABC123.Localhost:7777", { kind: "env", envId: "demo-abc123" }],
    ["demo-abc123-feat-0a1b.localhost:7777", { kind: "env", envId: "demo-abc123-feat-0a1b" }],
    ["localhost:8888", { kind: "reject" }],
    ["localhost", { kind: "reject" }],
    ["evil.com:7777", { kind: "reject" }],
    ["a.b.localhost:7777", { kind: "reject" }],
    ["-bad.localhost:7777", { kind: "reject" }],
    ["[::1]:7777", { kind: "reject" }],
    [undefined, { kind: "reject" }],
  ])("%s", (host, expected) => {
    expect(classifyHost(host, 7777)).toEqual(expected);
  });
});
