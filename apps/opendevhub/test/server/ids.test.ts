import { describe, expect, it } from "vitest";

import { newTaskId, projectId } from "../../src/server/ids";

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

describe(projectId, () => {
  it("slugs the basename and appends a 6-char path hash", () => {
    expect(projectId("/home/u/code/My App")).toMatch(/^my-app-[0-9a-f]{6}$/u);
  });

  it("is stable for the same path and differs for same name in different dirs", () => {
    expect(projectId("/a/web")).toBe(projectId("/a/web"));
    expect(projectId("/a/web")).not.toBe(projectId("/b/web"));
  });

  it.each([
    "/x/Über Projekt",
    "/x/项目",
    "/x/---weird___name---",
    `/x/${"very-long-name-".repeat(10)}`,
    "/x/UPPER.case.Dots",
  ])("produces a valid DNS label for %s", (p) => {
    const id = projectId(p);
    expect(id).toMatch(DNS_LABEL);
    expect(id.length).toBeLessThanOrEqual(63);
  });

  it("strips diacritics instead of splitting words", () => {
    expect(projectId("/x/Über")).toMatch(/^uber-[0-9a-f]{6}$/);
  });

  it("falls back to 'project' when nothing sluggable remains", () => {
    expect(projectId("/x/项目")).toMatch(/^project-[0-9a-f]{6}$/);
  });
});

describe(newTaskId, () => {
  it("is tsk_ plus a 26-character ULID that sorts by time", () => {
    const zero = () => new Uint8Array(16);
    expect(newTaskId(0, zero)).toBe(`tsk_${"0".repeat(26)}`);
    expect(newTaskId(1, zero)).toBe(`tsk_${"0".repeat(9)}1${"0".repeat(16)}`);
    expect(newTaskId(Date.now())).toMatch(/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(newTaskId(1e3, zero) < newTaskId(2e3, zero)).toBeTruthy();
  });
});
