import { describe, expect, it } from "vitest";
import type { CleanupItem, CleanupPlan } from "../../src/shared/types";
import { branchGroups, initialSelection, riskyNotes, selectionSummary, toggleAll } from "../../src/web/cleanup";

const GiB = 1024 ** 3;
const items: CleanupItem[] = [
  { id: "branch:a:feat", kind: "branch", checked: true, reason: "merged into main", projectId: "a", branch: "feat", base: "main", why: "merged" },
  { id: "branch:a:wip", kind: "branch", checked: false, reason: "merged into main", projectId: "a", branch: "wip", base: "main", why: "merged",
    worktree: "/workspaces/a.worktrees/wip", dirty: true },
  { id: "branch:b:sq", kind: "branch", checked: false, reason: "its upstream is gone; it may not be merged", projectId: "b", branch: "sq", base: "main", why: "upstream-gone" },
  { id: "container:c1", kind: "container", checked: false, reason: "x", containerId: "c1", name: "busy", running: true, why: "orphan-env" },
  { id: "container:c2", kind: "container", checked: true, reason: "x", containerId: "c2", running: false, why: "orphan-env" },
  { id: "image:i1", kind: "image", checked: true, reason: "x", ref: "i1", bytes: 2 * GiB, why: "superseded" },
  { id: "image:i2", kind: "image", checked: true, reason: "x", ref: "i2", bytes: GiB, why: "uid" },
];
const plan: CleanupPlan = { scannedAt: 0, projects: [{ id: "a", name: "alpha" }, { id: "b", name: "beta" }, { id: "c", name: "gamma", skipped: "not running" }], items };

describe("cleanup selection", () => {
  it("starts from the scan's defaults", () => {
    expect([...initialSelection(plan)]).toEqual(["branch:a:feat", "container:c2", "image:i1", "image:i2"]);
  });

  it("select-all and none leave risky rows alone", () => {
    const none = toggleAll(plan, new Set(["branch:a:feat", "branch:a:wip"]), "branch", false);
    expect([...none]).toEqual(["branch:a:wip"]);
    expect([...toggleAll(plan, new Set(), "branch", true)]).toEqual(["branch:a:feat"]);
  });

  it("summarises counts and image sizes", () => {
    expect(selectionSummary(plan, initialSelection(plan))).toBe("1 branch, 1 container, 2 images · 3.0 GiB");
    expect(selectionSummary(plan, new Set(["branch:a:feat", "branch:a:wip"]))).toBe("2 branches");
    expect(selectionSummary(plan, new Set())).toBe("Nothing selected");
  });

  it("names every risky selected item for the confirmation", () => {
    expect(riskyNotes(plan, new Set(items.map((i) => i.id)))).toEqual([
      "discards uncommitted changes in wip",
      "deletes sq, whose upstream is gone but which may not be merged",
      "stops and removes the running container busy",
    ]);
  });

  it("groups branches by project, keeping projects without any", () => {
    expect(branchGroups(plan).map((g) => [g.project.id, g.items.map((i) => i.branch)])).toEqual([
      ["a", ["feat", "wip"]],
      ["b", ["sq"]],
      ["c", []],
    ]);
  });
});
