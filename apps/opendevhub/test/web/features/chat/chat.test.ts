import { describe, expect, it } from "vitest";

import type { ProjectView } from "../../../../src/shared/types";
import {
  NEW_WORKTREE,
  chatPath,
  chatTarget,
  checkoutChoices,
  defaultChatProject,
  defaultCheckoutChoice,
} from "../../../../src/web/features/chat/chat";
import { webProject } from "../../../../src/web/mocks/fixtures";

const ws = webProject.runtime.workspaceFolder ?? "";
const unmounted: ProjectView = {
  ...webProject,
  runtime: { ...webProject.runtime, worktreeRoot: undefined },
};
const named = (name: string) =>
  ({
    ...webProject,
    project: { ...webProject.project, id: name, name },
  }) as ProjectView;

describe("chat", () => {
  it("opens with the last project chatted in, else the first one", () => {
    const projects = [named("a"), named("b")];
    expect(defaultChatProject(projects, "b")?.project.id).toBe("b");
    expect(defaultChatProject(projects, "gone")?.project.id).toBe("a");
    expect(defaultChatProject([], undefined)).toBeUndefined();
  });

  it("offers a new worktree, the main checkout and each worktree by branch", () => {
    expect(checkoutChoices(webProject).map((c) => c.label)).toStrictEqual([
      "New worktree",
      "Main checkout",
      "feat/rate-limit",
      "feat/dark-mode",
    ]);
    expect(defaultCheckoutChoice(webProject)).toBe(ws);
  });

  it("defaults to the main checkout when the project can't create worktrees", () => {
    expect(checkoutChoices(unmounted)[0]).toMatchObject({ disabled: true });
    expect(defaultCheckoutChoice(unmounted)).toBe(ws);
  });

  it("scopes a new worktree's suggestions to the main checkout, and sends a checkout's directory", () => {
    expect(chatTarget(webProject, NEW_WORKTREE)).toStrictEqual({
      directory: ws,
      label: "New worktree",
      target: { kind: "worktree" },
    });
    expect(chatTarget(webProject, ws)).toStrictEqual({
      directory: ws,
      label: "Main checkout",
      target: { directory: ws, kind: "checkout" },
    });
  });

  it("links a chat by project and task", () => {
    expect(chatPath("acme web", "tsk_1")).toBe("/chat/acme%20web/tsk_1");
  });
});
