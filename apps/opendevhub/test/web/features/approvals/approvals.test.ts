import { describe, expect, it } from "vitest";

import {
  approvalSummary,
  composeFileDiffs,
  lineDiff,
  mainApproval,
  sourceLabels,
  worktreeApproval,
} from "../../../../src/web/features/approvals/approvals";
import {
  configApproval,
  firstConfigApproval,
  webProject,
} from "../../../../src/web/mocks/fixtures";

const view = {
  ...webProject,
  approvals: [configApproval, firstConfigApproval],
};

describe("config approvals", () => {
  it("finds the approval blocking the main checkout or a worktree", () => {
    expect(mainApproval(view)).toBe(firstConfigApproval);
    expect(worktreeApproval(view, "feat/dark-mode", undefined)).toBe(
      configApproval
    );
    expect(worktreeApproval(view, "feat/dark-mode", "box")).toBeUndefined();
    expect(worktreeApproval(view, undefined, undefined)).toBeUndefined();
    expect(mainApproval(webProject)).toBeUndefined();
  });

  it("names what changed, leaving unchanged settings out", () => {
    expect(approvalSummary(configApproval)).toBe(
      "Docker Compose files, Command on the host (initializeCommand), Mounts"
    );
    expect(sourceLabels(configApproval)).toStrictEqual([
      "worktree feat/dark-mode",
    ]);
    expect(sourceLabels(firstConfigApproval)).toStrictEqual([
      "the main checkout",
    ]);
  });

  it("diffs Compose files by line", () => {
    const [file] = composeFileDiffs(configApproval.changes[0]);
    expect(file.path).toBe(".devcontainer/compose.yml");
    expect(file.lines.filter((l) => l.kind !== "same")).toStrictEqual([
      { kind: "added", text: "    volumes:" },
      {
        kind: "added",
        text: "      - /var/run/docker.sock:/var/run/docker.sock",
      },
    ]);
    expect(lineDiff("a\nb\n", "a\nc\n")).toStrictEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "c" },
    ]);
    expect(lineDiff("", "x")).toStrictEqual([{ kind: "added", text: "x" }]);
  });
});
