import { describe, expect, it } from "vitest";
import type { RawAgent, RawModel } from "../../src/server/opencode/client";
import { discardMetadata, parseTaskMeta, parseTaskRequest, toModelsInfo } from "../../src/server/tasks";
import { InvalidRequestError } from "../../src/server/worktrees";

describe("parseTaskRequest", () => {
  it("fills in the defaults", () => {
    expect(parseTaskRequest({ prompt: " Fix it \n" })).toEqual({ prompt: "Fix it", where: "worktree", variants: [{}] });
  });

  it("keeps every field it understands", () => {
    expect(
      parseTaskRequest({
        prompt: "Fix it",
        title: " Login ",
        branch: "feature/x",
        base: "main",
        variants: [{ model: { id: "anthropic/claude-opus-5-5", providerID: "openrouter", variant: "high" }, agent: "build" }, {}],
        extra: true,
      }),
    ).toEqual({
      prompt: "Fix it",
      title: "Login",
      where: "worktree",
      branch: "feature/x",
      base: "main",
      variants: [{ model: { id: "anthropic/claude-opus-5-5", providerID: "openrouter", variant: "high" }, agent: "build" }, {}],
    });
  });

  it.each([
    [{ prompt: "  " }, /prompt is empty/],
    [{ prompt: "x".repeat(100_001) }, /longer than/],
    [{ prompt: "x", title: "t".repeat(201) }, /title/],
    [{ prompt: "x", where: "elsewhere" }, /invalid where/],
    [{ prompt: "x", variants: [] }, /1 to 4/],
    [{ prompt: "x", variants: [{}, {}, {}, {}, {}] }, /1 to 4/],
    [{ prompt: "x", variants: ["gpt"] }, /variant 1 must be an object/],
    [{ prompt: "x", variants: [{ model: { id: "m" } }] }, /variant 1: model/],
    [{ prompt: "x", variants: [{}, { agent: "rm -rf /" }] }, /variant 2: invalid agent/],
    [{ prompt: "x", branch: "a b" }, /invalid branch/],
    [{ prompt: "x", base: "--upload-pack=x" }, /invalid branch/],
    [{ prompt: "x", where: "workspace", variants: [{}, {}] }, /worktree each/],
    [{ prompt: "x", where: "workspace", branch: "b" }, /only apply to a new worktree/],
  ])("rejects %j", (body, message) => {
    expect(() => parseTaskRequest(body as Record<string, unknown>)).toThrow(InvalidRequestError);
    expect(() => parseTaskRequest(body as Record<string, unknown>)).toThrow(message);
  });
});

describe("task metadata", () => {
  it("reads opendevhub's task metadata and ignores anything else", () => {
    const meta = { task: "tsk_1", variant: 2, of: 3, title: "Fix" };
    expect(parseTaskMeta({ opendevhub: meta, other: 1 })).toEqual(meta);
    expect(parseTaskMeta({ opendevhub: { ...meta, discarded: true } })).toEqual({ ...meta, discarded: true });
    expect(parseTaskMeta({ opendevhub: { ...meta, title: 5 } })).toEqual({ ...meta, title: "" });
    expect(parseTaskMeta(undefined)).toBeUndefined();
    expect(parseTaskMeta({ opendevhub: { task: "nope", variant: 1, of: 1 } })).toBeUndefined();
    expect(parseTaskMeta({ opendevhub: { task: "tsk_1", variant: 4, of: 3 } })).toBeUndefined();
    expect(parseTaskMeta({ opendevhub: { task: "tsk_1", variant: 0, of: 3 } })).toBeUndefined();
    expect(parseTaskMeta("x")).toBeUndefined();
  });

  it("marks a variant discarded without dropping any other metadata", () => {
    const meta = { other: 1, opendevhub: { task: "tsk_1", variant: 2, of: 2, title: "t" } };
    expect(discardMetadata(meta)).toEqual({ other: 1, opendevhub: { task: "tsk_1", variant: 2, of: 2, title: "t", discarded: true } });
    expect(meta.opendevhub).not.toHaveProperty("discarded");
    expect(discardMetadata(undefined)).toEqual({ opendevhub: { discarded: true } });
  });
});

describe("toModelsInfo", () => {
  it("passes on only names and ids, never provider settings", () => {
    const models = [
      { id: "m1", providerID: "p", name: "M1", enabled: true, status: "active", variants: [{ id: "high" }], settings: { apiKey: "secret" }, headers: { authorization: "secret" } },
      { id: "m2", providerID: "p", name: "M2", enabled: false, variants: [] },
      { id: "m3", providerID: "p", name: "M3", enabled: true, status: "deprecated", variants: [] },
    ] as unknown as RawModel[];
    const agents: RawAgent[] = [
      { id: "build", name: "Build", mode: "primary", hidden: false, description: "Default" },
      { id: "general", name: "General", mode: "subagent" },
      { id: "title", name: "Title", mode: "primary", hidden: true },
      { id: "plan", name: "Plan", mode: "all" },
    ];
    const info = toModelsInfo(models, models[0], agents);
    expect(info).toEqual({
      models: [{ id: "m1", providerID: "p", name: "M1", variants: ["high"] }],
      default: { id: "m1", providerID: "p" },
      agents: [
        { id: "build", name: "Build", description: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });
    expect(JSON.stringify(info)).not.toContain("secret");
    expect(toModelsInfo([], undefined, [])).toEqual({ models: [], agents: [] });
  });
});
