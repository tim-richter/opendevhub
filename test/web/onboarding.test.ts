import { describe, expect, it } from "vitest";
import { addedDestination, candidateLabel } from "../../src/web/onboarding";

describe("candidateLabel", () => {
  it("shows the path relative to the root", () => {
    expect(candidateLabel({ path: "/home/u/code/org/app", name: "app", root: "/home/u/code", stack: "node" })).toBe("org/app");
  });
  it("shows the folder name when the root itself is the repo", () => {
    expect(candidateLabel({ path: "/home/u/code", name: "code", root: "/home/u/code", stack: "node" })).toBe("code");
  });
});

describe("addedDestination", () => {
  it("links to the project page", () => {
    expect(addedDestination({ projectId: "my app-abc123", started: true })).toBe("/p/my%20app-abc123");
  });
});
