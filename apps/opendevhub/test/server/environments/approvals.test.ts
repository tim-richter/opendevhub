import { describe, expect, it } from "vitest";

import { openDatabase } from "../../../src/server/db/database";
import {
  ConfigApprovals,
  diffSurfaces,
} from "../../../src/server/environments/approvals";
import { fingerprint } from "../../../src/server/environments/config-surface";
import { ConflictError } from "../../../src/server/errors";
import type { ConfigApprovalSource } from "../../../src/shared/types";

const MAIN: ConfigApprovalSource = { kind: "main" };
const FEAT: ConfigApprovalSource = {
  branch: "feat",
  envId: "demo-feat",
  kind: "worktree",
  node: "local",
};

const setup = () => {
  let now = 1000;
  const db = openDatabase(":memory:");
  const approvals = new ConfigApprovals(db, () => (now += 1));
  return { approvals, db };
};

const pendingOf = (
  result: ReturnType<ConfigApprovals["check"]>
): NonNullable<Extract<typeof result, { ok: false }>["pending"]> => {
  if (result.ok) {
    throw new Error("expected a pending approval");
  }
  return result.pending;
};

describe(ConfigApprovals, () => {
  it("allows empty settings without asking", () => {
    const { approvals } = setup();
    expect(approvals.check("demo", {}, MAIN)).toStrictEqual({ ok: true });
    expect(approvals.pending("demo")).toStrictEqual([]);
  });

  it("asks once, then allows the same settings from any checkout and after a restart", () => {
    const { approvals, db } = setup();
    const surface = { initializeCommand: "echo hi" };
    const pending = pendingOf(approvals.check("demo", surface, MAIN));
    expect(pending.first).toBe(true);
    expect(pending.changes).toStrictEqual([
      { after: "echo hi", key: "initializeCommand", kind: "added" },
    ]);
    approvals.approve("demo", pending.fingerprint);
    expect(approvals.pending("demo")).toStrictEqual([]);
    expect(approvals.check("demo", surface, FEAT).ok).toBe(true);
    expect(new ConfigApprovals(db).check("demo", surface, FEAT).ok).toBe(true);
    // Approvals are per project.
    expect(approvals.check("other", surface, MAIN).ok).toBe(false);
  });

  it("allows either of two approved sets", () => {
    const { approvals } = setup();
    const a = { mounts: ["a"] };
    const b = { mounts: ["b"] };
    approvals.approve(
      "demo",
      pendingOf(approvals.check("demo", a, MAIN)).fingerprint
    );
    approvals.approve(
      "demo",
      pendingOf(approvals.check("demo", b, FEAT)).fingerprint
    );
    expect(approvals.check("demo", a, FEAT).ok).toBe(true);
    expect(approvals.check("demo", b, MAIN).ok).toBe(true);
  });

  it("diffs against the closest approval: added, changed, removed and unchanged", () => {
    const { approvals } = setup();
    const approved = {
      initializeCommand: "a",
      mounts: ["m1"],
      runArgs: ["--x"],
    };
    approvals.approve(
      "demo",
      pendingOf(approvals.check("demo", approved, MAIN)).fingerprint
    );
    approvals.approve(
      "demo",
      pendingOf(approvals.check("demo", { privileged: true }, MAIN)).fingerprint
    );
    const pending = pendingOf(
      approvals.check(
        "demo",
        { capAdd: ["SYS_ADMIN"], initializeCommand: "a", mounts: ["m1", "m2"] },
        MAIN
      )
    );
    expect(pending.first).toBe(false);
    expect(pending.changes).toStrictEqual([
      { after: ["SYS_ADMIN"], key: "capAdd", kind: "added" },
      { after: "a", before: "a", key: "initializeCommand", kind: "unchanged" },
      { after: ["m1", "m2"], before: ["m1"], key: "mounts", kind: "changed" },
      { before: ["--x"], key: "runArgs", kind: "removed" },
    ]);
  });

  it("keeps one pending approval per checkout, and merges checkouts with the same settings", () => {
    const { approvals } = setup();
    const first = pendingOf(approvals.check("demo", { mounts: ["a"] }, MAIN));
    pendingOf(approvals.check("demo", { mounts: ["a"] }, FEAT));
    expect(approvals.pending("demo")).toHaveLength(1);
    expect(approvals.pending("demo")[0].sources).toStrictEqual([MAIN, FEAT]);
    // The main checkout's config changes again: its old pending approval stays only for the worktree.
    const second = pendingOf(approvals.check("demo", { mounts: ["b"] }, MAIN));
    expect(
      approvals.pendingOf("demo", first.fingerprint)?.sources
    ).toStrictEqual([FEAT]);
    approvals.forget("demo", FEAT);
    expect(approvals.pending("demo").map((p) => p.fingerprint)).toStrictEqual([
      second.fingerprint,
    ]);
  });

  it("refuses to approve settings that are no longer pending", () => {
    const { approvals } = setup();
    expect(() => approvals.approve("demo", fingerprint({ x: 1 }))).toThrow(
      ConflictError
    );
  });

  it("settles waiters on approve, refuse and cancel, and runs blocked starts on approve", async () => {
    const { approvals } = setup();
    const a = pendingOf(approvals.check("demo", { mounts: ["a"] }, MAIN));
    const b = pendingOf(approvals.check("demo", { mounts: ["b"] }, FEAT));
    let cancel = false;
    const c = pendingOf(
      approvals.check("demo", { mounts: ["c"] }, { ...FEAT, envId: "demo-c" })
    );
    const approved = approvals.wait("demo", a.fingerprint, () => false);
    const refused = approvals.wait("demo", b.fingerprint, () => false);
    const cancelled = approvals.wait("demo", c.fingerprint, () => cancel);
    let retried = 0;
    approvals.retryOnApprove("demo", a.fingerprint, MAIN, () => (retried += 1));
    approvals.approve("demo", a.fingerprint);
    approvals.refuse("demo", b.fingerprint);
    cancel = true;
    approvals.recheckCancelled();
    await expect(approved).resolves.toBe("approved");
    await expect(refused).resolves.toBe("refused");
    await expect(cancelled).resolves.toBe("cancelled");
    expect(retried).toBe(1);
    // A wait on settings already answered settles at once.
    await expect(
      approvals.wait("demo", a.fingerprint, () => false)
    ).resolves.toBe("approved");
    await expect(
      approvals.wait("demo", b.fingerprint, () => false)
    ).resolves.toBe("refused");
  });

  it("tells subscribers about pending changes", () => {
    const { approvals } = setup();
    let calls = 0;
    approvals.subscribe(() => (calls += 1));
    const p = pendingOf(approvals.check("demo", { mounts: ["a"] }, MAIN));
    approvals.refuse("demo", p.fingerprint);
    expect(calls).toBe(2);
  });
});

describe(diffSurfaces, () => {
  it("shows every setting as added against nothing", () => {
    expect(diffSurfaces({}, { a: 1 })).toStrictEqual([
      { after: 1, key: "a", kind: "added" },
    ]);
  });
});
