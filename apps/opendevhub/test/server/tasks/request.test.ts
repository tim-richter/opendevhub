import { describe, expect, it } from "vitest";

import { InvalidRequestError } from "../../../src/server/git/worktrees";
import type { RawAgent, RawModel } from "../../../src/server/opencode/client";
import {
  parseTaskRequest,
  toModelsInfo,
} from "../../../src/server/tasks/request";

const jira = {
  key: "APP-12",
  instanceUrl: "https://jira.example.com/jira",
  title: "Fix login",
  description: "Safari login must succeed.",
};

describe(parseTaskRequest, () => {
  it("preserves a validated ticket snapshot and strips unknown fields", () => {
    expect(
      parseTaskRequest({ prompt: "Fix", jira: { ...jira, token: "secret" } })
        .jira
    ).toStrictEqual(jira);
    for (const source of [
      null,
      { ...jira, key: "../APP-12" },
      { ...jira, instanceUrl: "https://user:secret@example.com" },
      { ...jira, description: {} },
      { ...jira, description: "x".repeat(100_001) },
    ]) {
      expect(() => parseTaskRequest({ prompt: "Fix", jira: source })).toThrow();
    }
  });

  it("reads the node, leaving it out for this machine", () => {
    expect(
      parseTaskRequest({ prompt: "x", environment: "isolated", node: "box" })
        .node
    ).toBe("box");
    expect(
      parseTaskRequest({ prompt: "x", node: "local" }).node
    ).toBeUndefined();
    expect(parseTaskRequest({ prompt: "x" }).node).toBeUndefined();
    expect(() => parseTaskRequest({ prompt: "x", node: "Bad Node" })).toThrow(
      /invalid node/u
    );
  });

  it("accepts the environment of worktree tasks", () => {
    expect(
      parseTaskRequest({ prompt: "x", environment: "isolated" }).environment
    ).toBe("isolated");
    expect(parseTaskRequest({ prompt: "x" })).not.toHaveProperty("environment");
    expect(() => parseTaskRequest({ prompt: "x", environment: "vm" })).toThrow(
      /invalid environment/u
    );
    expect(() =>
      parseTaskRequest({
        prompt: "x",
        where: "workspace",
        environment: "isolated",
      })
    ).toThrow(/new worktree/u);
  });

  it("fills in the defaults", () => {
    expect(parseTaskRequest({ prompt: " Fix it \n" })).toStrictEqual({
      prompt: "Fix it",
      where: "worktree",
      variants: [{}],
    });
  });

  it("reads spec-first, which must be a boolean: implementing needs an approved spec", () => {
    expect(parseTaskRequest({ prompt: "x", spec: true }).spec).toStrictEqual({
      phase: "propose",
    });
    expect(() =>
      parseTaskRequest({
        prompt: "x",
        spec: { change: "add-login", phase: "implement", proposedIn: "tsk_1" },
      })
    ).toThrow(InvalidRequestError);
    expect(parseTaskRequest({ prompt: "x", spec: false })).not.toHaveProperty(
      "spec"
    );
    expect(() => parseTaskRequest({ prompt: "x", spec: "yes" })).toThrow(
      InvalidRequestError
    );
  });

  it("keeps every field it understands", () => {
    expect(
      parseTaskRequest({
        prompt: "Fix it",
        title: " Login ",
        branch: "feature/x",
        base: "main",
        variants: [
          {
            model: {
              id: "anthropic/claude-opus-5-5",
              providerID: "openrouter",
              variant: "high",
            },
            agent: "build",
          },
          {},
        ],
        extra: true,
      })
    ).toStrictEqual({
      prompt: "Fix it",
      title: "Login",
      where: "worktree",
      branch: "feature/x",
      base: "main",
      variants: [
        {
          model: {
            id: "anthropic/claude-opus-5-5",
            providerID: "openrouter",
            variant: "high",
          },
          agent: "build",
        },
        {},
      ],
    });
  });

  it.each([
    [{ prompt: "  " }, /prompt is empty/u],
    [{ prompt: "x".repeat(100_001) }, /longer than/u],
    [{ prompt: "x", title: "t".repeat(201) }, /title/u],
    [{ prompt: "x", where: "elsewhere" }, /invalid where/u],
    [{ prompt: "x", variants: [] }, /1 to 4/u],
    [{ prompt: "x", variants: [{}, {}, {}, {}, {}] }, /1 to 4/u],
    [{ prompt: "x", variants: ["gpt"] }, /variant 1 must be an object/u],
    [{ prompt: "x", variants: [{ model: { id: "m" } }] }, /variant 1: model/u],
    [
      { prompt: "x", variants: [{}, { agent: "rm -rf /" }] },
      /variant 2: invalid agent/u,
    ],
    [{ prompt: "x", branch: "a b" }, /invalid branch/u],
    [{ prompt: "x", base: "--upload-pack=x" }, /invalid branch/u],
    [{ prompt: "x", where: "workspace", variants: [{}, {}] }, /worktree each/u],
    [
      { prompt: "x", where: "workspace", branch: "b" },
      /only apply to a new worktree/u,
    ],
  ])("rejects %j", (body, message) => {
    expect(() => parseTaskRequest(body as Record<string, unknown>)).toThrow(
      InvalidRequestError
    );
    expect(() => parseTaskRequest(body as Record<string, unknown>)).toThrow(
      message
    );
  });
});

describe(toModelsInfo, () => {
  it("passes on only names and ids, never provider settings", () => {
    const models = [
      {
        id: "m1",
        providerID: "p",
        name: "M1",
        enabled: true,
        status: "active",
        variants: [{ id: "high" }],
        settings: { apiKey: "secret" },
        headers: { authorization: "secret" },
      },
      { id: "m2", providerID: "p", name: "M2", enabled: false, variants: [] },
      {
        id: "m3",
        providerID: "p",
        name: "M3",
        enabled: true,
        status: "deprecated",
        variants: [],
      },
    ] as unknown as RawModel[];
    const agents: RawAgent[] = [
      {
        id: "build",
        name: "Build",
        mode: "primary",
        hidden: false,
        description: "Default",
      },
      { id: "general", name: "General", mode: "subagent" },
      { id: "title", name: "Title", mode: "primary", hidden: true },
      { id: "plan", name: "Plan", mode: "all" },
    ];
    const info = toModelsInfo(models, models[0], agents);
    expect(info).toStrictEqual({
      models: [{ id: "m1", providerID: "p", name: "M1", variants: ["high"] }],
      default: { id: "m1", providerID: "p" },
      agents: [
        { id: "build", name: "Build", description: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });
    expect(JSON.stringify(info)).not.toContain("secret");
    expect(toModelsInfo([], undefined, [])).toStrictEqual({
      models: [],
      agents: [],
    });
  });
});
