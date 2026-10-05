import { describe, expect, it } from "vitest";
import { isStackId, OPENCODE_INSTALL, renderDevcontainer, STACK_IDS, STACKS } from "../../src/shared/stacks";

describe("stacks", () => {
  it("has an mcr devcontainers image for every stack", () => {
    for (const id of STACK_IDS) {
      expect(STACKS[id].id).toBe(id);
      expect(STACKS[id].image).toMatch(/^mcr\.microsoft\.com\/devcontainers\/[a-z-]+:[\w.]+$/);
    }
    expect(STACKS.node.image).toBe("mcr.microsoft.com/devcontainers/javascript-node:22");
    expect(STACKS.generic.image).toBe("mcr.microsoft.com/devcontainers/base:ubuntu");
  });

  it("recognises stack ids only", () => {
    expect(isStackId("rust")).toBe(true);
    expect(isStackId("toString")).toBe(false);
    expect(isStackId(undefined)).toBe(false);
  });

  it("renders name, image and the opencode installer, in that order", () => {
    const text = renderDevcontainer("my-app", "python");
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(["name", "image", "postCreateCommand"]);
    expect(JSON.parse(text)).toEqual({
      name: "my-app",
      image: "mcr.microsoft.com/devcontainers/python:3",
      postCreateCommand: "curl -fsSL https://opencode.ai/v2/install | bash",
    });
    expect(OPENCODE_INSTALL).toBe("curl -fsSL https://opencode.ai/v2/install | bash");
    expect(text).toContain('\n  "name": "my-app"');
  });

  it("escapes names that need it", () => {
    expect(JSON.parse(renderDevcontainer('we"ird', "generic")).name).toBe('we"ird');
  });
});
