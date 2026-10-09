import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckTarget } from "../../../src/server/environments/checks";
import { InvalidRequestError } from "../../../src/server/git/worktrees";
import type { RunResult } from "../../../src/server/nodes/exec";
import {
  parseSections,
  parseStatus,
  parseValidation,
  pickChange,
  Specs,
} from "../../../src/server/specs/specs";
import type { SpecsDeps } from "../../../src/server/specs/specs";
import type { Project, SessionSummary } from "../../../src/shared/types";

const MARK = "@@opendevhub-spec@@";
const section = (name: string, body: unknown, code = 0) =>
  `${typeof body === "string" ? body : JSON.stringify(body)}\n${MARK} ${name} ${code}\n`;

const list = (...names: string[]) => ({
  changes: names.map((name, i) => ({
    completedTasks: 1,
    lastModified: `2026-10-0${i + 1}T00:00:00Z`,
    name,
    totalTasks: 3,
  })),
});
const STATUS = {
  applyRequires: ["tasks"],
  artifacts: [
    { id: "proposal", outputPath: "proposal.md", status: "done" },
    {
      id: "tasks",
      missingDeps: ["specs"],
      outputPath: "tasks.md",
      status: "blocked",
    },
  ],
  isComplete: false,
};
const VALID = { items: [{ id: "add-login", issues: [], valid: true }] };

const ok = (stdout: string): RunResult => ({
  exitCode: 0,
  stderr: "",
  stdout,
  timedOut: false,
});

let host: string;
beforeEach(async () => {
  host = await fs.mkdtemp(path.join(os.tmpdir(), "specs-"));
  const change = path.join(host, "openspec/changes/add-login");
  await fs.mkdir(path.join(change, "specs/auth"), { recursive: true });
  await fs.mkdir(path.join(host, "openspec/specs/auth"), { recursive: true });
  await fs.writeFile(path.join(change, "tasks.md"), "- [ ] 1.1 Do it\n");
  await fs.writeFile(path.join(change, "proposal.md"), "## Why\nLogin.\n");
  await fs.writeFile(
    path.join(change, "specs/auth/spec.md"),
    "## MODIFIED Requirements\n### Requirement: Timeout\nAfter 15 minutes.\n"
  );
  await fs.writeFile(
    path.join(host, "openspec/specs/auth/spec.md"),
    "## Requirements\n### Requirement: Timeout\nAfter 30 minutes.\n"
  );
});
afterEach(async () => {
  await fs.rm(host, { force: true, recursive: true });
});

const project = { id: "p" } as Project;
const target = (over: Partial<CheckTarget> = {}): CheckTarget => ({
  checkout: { container: "/workspaces/wt", host },
  exec: project,
  isMain: false,
  project,
  ...over,
});

const taskSession = (spec: {
  phase: "propose";
  change?: string;
}): SessionSummary =>
  ({
    directory: "/workspaces/wt",
    id: "ses_1",
    task: { of: 1, spec, task: "tsk_1", title: "Login", variant: 1 },
    title: "Login",
  }) as SessionSummary;

const make = (opts: {
  outputs: string[];
  target?: CheckTarget;
  sessions?: SessionSummary[];
}) => {
  const exec = vi.fn(async (_target: unknown, _argv: string[]) =>
    ok(opts.outputs.shift() ?? "")
  );
  const client = {
    session: vi.fn(async () => ({
      metadata: { opendevhub: { task: "tsk_1" }, x: 1 },
    })),
    updateSession: vi.fn(async () => undefined),
  };
  const reconcile = vi.fn();
  const deps: SpecsDeps = {
    client: () => client as never,
    containers: { exec },
    log: vi.fn(),
    reconcile,
    sessions: () => opts.sessions ?? [],
    target: () => opts.target ?? target(),
  };
  return { client, exec, reconcile, specs: new Specs(deps) };
};

describe(parseSections, () => {
  it("splits the script's output at its marks", () => {
    const out = parseSections(
      `openspec/changes/a\n${MARK} base 0\n{"x":1}\n\n${MARK} list 0\n`
    );
    expect(out.get("base")).toStrictEqual({
      code: 0,
      text: "openspec/changes/a",
    });
    expect(out.get("list")).toStrictEqual({ code: 0, text: '{"x":1}' });
  });
});

describe(parseStatus, () => {
  it("is planning-complete when every artifact apply needs is done", () => {
    expect(parseStatus(STATUS).planningComplete).toBe(false);
    expect(
      parseStatus({ ...STATUS, applyRequires: ["proposal"] })
    ).toMatchObject({
      artifacts: [{ id: "proposal" }, { id: "tasks", missingDeps: ["specs"] }],
      planningComplete: true,
    });
    expect(parseStatus({ isComplete: true }).planningComplete).toBe(true);
  });
});

describe(parseValidation, () => {
  it("lists the change's issues", () => {
    expect(
      parseValidation(
        {
          items: [
            {
              id: "a",
              issues: [
                { level: "ERROR", message: "No deltas", path: "file" },
                { message: "Needs a scenario", path: "specs/auth" },
              ],
              valid: false,
            },
          ],
        },
        "a"
      )
    ).toStrictEqual({
      issues: ["No deltas", "specs/auth: Needs a scenario"],
      valid: false,
    });
  });
});

describe(pickChange, () => {
  const changes = [
    {
      completedTasks: 0,
      isNew: false,
      lastModified: "2026-10-03",
      name: "old",
      totalTasks: 0,
    },
    {
      completedTasks: 0,
      isNew: true,
      lastModified: "2026-10-01",
      name: "a",
      totalTasks: 0,
    },
    {
      completedTasks: 0,
      isNew: true,
      lastModified: "2026-10-02",
      name: "b",
      totalTasks: 0,
    },
  ];
  it("prefers the asked change, then the newest new one", () => {
    expect(pickChange(changes, "a", true)).toBe("a");
    expect(pickChange(changes, "gone", true)).toBe("b");
    expect(pickChange(changes, undefined, false)).toBe("old");
    expect(pickChange([changes[0]], undefined, true)).toBeUndefined();
  });
});

describe(Specs, () => {
  it("shows the one new change, with its documents and requirements, and records it on the task", async () => {
    const { specs, exec, client, reconcile } = make({
      outputs: [
        section("base", "openspec/changes/archive\nopenspec/changes/old") +
          section("list", list("old", "add-login")),
        section("status", STATUS) + section("validate", VALID),
      ],
      sessions: [taskSession({ phase: "propose" })],
    });
    const view = await specs.view("p", "/workspaces/wt");
    expect(view.changes.map((c) => [c.name, c.isNew])).toStrictEqual([
      ["old", false],
      ["add-login", true],
    ]);
    expect(view.change?.name).toBe("add-login");
    expect(view.change?.documents.map((d) => d.path)).toStrictEqual([
      "proposal.md",
      "tasks.md",
      "specs/auth/spec.md",
    ]);
    expect(view.change?.requirements).toStrictEqual([
      {
        before: "### Requirement: Timeout\nAfter 30 minutes.",
        capability: "auth",
        delta: "### Requirement: Timeout\nAfter 15 minutes.",
        name: "Timeout",
        operation: "MODIFIED",
      },
    ]);
    expect(view.change?.validation).toStrictEqual({ issues: [], valid: true });
    // The first exec lists, with the base; the second reports on the change it picked.
    expect(exec.mock.calls[0][1].slice(4)).toStrictEqual([
      "/workspaces/wt",
      "list",
      "base",
      "",
    ]);
    expect(exec.mock.calls[1][1].slice(4)).toStrictEqual([
      "/workspaces/wt",
      "",
      "",
      "add-login",
    ]);
    expect(client.updateSession).toHaveBeenCalledWith(
      "ses_1",
      {
        metadata: {
          opendevhub: {
            spec: { change: "add-login", phase: "propose" },
            task: "tsk_1",
          },
          x: 1,
        },
      },
      "/workspaces/wt"
    );
    expect(reconcile).toHaveBeenCalledWith("p");
  });

  it("reports on the recorded change in one exec, and doesn't record it again", async () => {
    const { specs, exec, client } = make({
      outputs: [
        section("base", "") +
          section("list", list("add-login")) +
          section("status", STATUS) +
          section("validate", VALID),
      ],
      sessions: [taskSession({ change: "add-login", phase: "propose" })],
    });
    const view = await specs.view("p", "/workspaces/wt");
    expect(view.change?.name).toBe("add-login");
    expect(exec).toHaveBeenCalledOnce();
    expect(client.updateSession).not.toHaveBeenCalled();
  });

  it("lists every change in the main checkout, showing the newest", async () => {
    const { specs, exec } = make({
      outputs: [
        section("list", list("add-login", "other")),
        section("status", STATUS) + section("validate", VALID),
      ],
      target: target({ isMain: true }),
    });
    const view = await specs.view("p", "/workspaces/wt");
    expect(view.changes.every((c) => !c.isNew)).toBe(true);
    expect(view.change?.name).toBe("other");
    expect(exec.mock.calls[0][1][6]).toBe("");
  });

  it("shows no change while the task hasn't proposed one", async () => {
    const { specs, exec } = make({
      outputs: [
        section("base", "openspec/changes/old") + section("list", list("old")),
      ],
    });
    expect(await specs.view("p", "/workspaces/wt")).toStrictEqual({
      changes: [
        {
          completedTasks: 1,
          isNew: false,
          lastModified: "2026-10-01T00:00:00Z",
          name: "old",
          totalTasks: 3,
        },
      ],
    });
    expect(exec).toHaveBeenCalledOnce();
  });

  it("says why it can't read the spec", async () => {
    const remote = make({
      outputs: [],
      target: target({ checkout: { container: "/w" } }),
    });
    expect((await remote.specs.view("p", "/w")).unavailable).toMatch(
      /other nodes/u
    );
    expect(remote.exec).not.toHaveBeenCalled();

    const stopped = make({
      outputs: [],
      target: target({ unavailable: "the project's container is not running" }),
    });
    expect((await stopped.specs.view("p", "/w")).unavailable).toBe(
      "the project's container is not running"
    );

    const noCli = make({
      outputs: [section("list", "openspec: command not found", 127)],
    });
    expect((await noCli.specs.view("p", "/w")).unavailable).toMatch(
      /no openspec CLI/u
    );

    const broken = make({ outputs: [section("list", "Error: bad config", 1)] });
    expect((await broken.specs.view("p", "/w")).unavailable).toBe(
      "openspec list failed: Error: bad config"
    );
  });

  it("rejects a change name that isn't one", async () => {
    const { specs } = make({ outputs: [] });
    await expect(specs.view("p", "/w", "../etc")).rejects.toThrow(
      InvalidRequestError
    );
  });
});
