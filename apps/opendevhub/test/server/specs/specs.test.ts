import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CheckTarget } from "../../../src/server/environments/checks";
import { InvalidRequestError } from "../../../src/server/git/worktrees";
import type { RunResult } from "../../../src/server/nodes/exec";
import {
  parseArchive,
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

const taskSession = (
  spec: {
    phase: "propose" | "implement" | "archived";
    change?: string;
    archived?: string;
  },
  status: SessionSummary["status"] = "idle"
): SessionSummary =>
  ({
    directory: "/workspaces/wt",
    id: "ses_1",
    status,
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
    command: vi.fn(async () => undefined),
    commands: vi.fn(async () => [
      { name: "opsx-update" },
      { name: "opsx-apply" },
    ]),
    session: vi.fn(async () => ({
      metadata: { opendevhub: { task: "tsk_1" }, x: 1 },
    })),
    updateSession: vi.fn(
      async (_id: string, _body: unknown, _directory?: string) => undefined
    ),
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
      "",
    ]);
    expect(exec.mock.calls[1][1].slice(4)).toStrictEqual([
      "/workspaces/wt",
      "",
      "",
      "add-login",
      "",
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

describe("Specs.revise", () => {
  it("runs /opsx-update with the change and the feedback in the task's session", async () => {
    const { client, reconcile, specs } = make({
      outputs: [],
      sessions: [taskSession({ change: "add-login", phase: "propose" })],
    });
    await specs.revise(
      "p",
      "/workspaces/wt",
      "add-login",
      " Shorter timeout. "
    );
    expect(client.command).toHaveBeenCalledWith(
      "ses_1",
      "opsx-update",
      "add-login\n\nShorter timeout.",
      "/workspaces/wt"
    );
    expect(reconcile).toHaveBeenCalledWith("p");
  });

  it("refuses once the spec is approved, while the agent works, or without the command", async () => {
    const approved = make({
      outputs: [],
      sessions: [taskSession({ phase: "implement" })],
    });
    await expect(
      approved.specs.revise("p", "/workspaces/wt", "add-login", "x")
    ).rejects.toThrow("only be revised while it's proposed");

    const busy = make({
      outputs: [],
      sessions: [taskSession({ phase: "propose" }, "running")],
    });
    await expect(
      busy.specs.revise("p", "/workspaces/wt", "add-login", "x")
    ).rejects.toThrow("still busy");

    const missing = make({
      outputs: [],
      sessions: [taskSession({ phase: "propose" })],
    });
    missing.client.commands.mockResolvedValue([]);
    await expect(
      missing.specs.revise("p", "/workspaces/wt", "add-login", "x")
    ).rejects.toThrow("no opsx-update command");
    expect(missing.client.command).not.toHaveBeenCalled();
  });

  it("rejects bad input and checkouts without a spec-first task", async () => {
    const { specs } = make({ outputs: [] });
    await expect(
      specs.revise("p", "/workspaces/wt", "../etc", "x")
    ).rejects.toThrow(InvalidRequestError);
    await expect(
      specs.revise("p", "/workspaces/wt", "add-login", "  ")
    ).rejects.toThrow("feedback is empty");
    await expect(
      specs.revise("p", "/workspaces/wt", "add-login", "x")
    ).rejects.toThrow("no spec-first task");
  });
});

const READY = {
  ...STATUS,
  artifacts: STATUS.artifacts.map((a) => ({
    id: a.id,
    outputPath: a.outputPath,
    status: "done",
  })),
};
const INVALID = {
  items: [
    {
      id: "add-login",
      issues: [{ message: "no scenarios", path: "auth" }],
      valid: false,
    },
  ],
};
const report = (status: unknown, validate: unknown) =>
  section("list", list("add-login")) +
  section("status", status) +
  section("validate", validate);

describe("Specs.approve", () => {
  it("records the implement phase, then runs /opsx-apply with the change", async () => {
    const { client, exec, reconcile, specs } = make({
      outputs: [report(READY, VALID)],
      sessions: [taskSession({ phase: "propose" })],
    });
    await specs.approve("p", "/workspaces/wt", "add-login");
    expect(exec.mock.calls[0][1].slice(4)).toStrictEqual([
      "/workspaces/wt",
      "list",
      "",
      "add-login",
      "",
    ]);
    expect(client.updateSession).toHaveBeenCalledWith(
      "ses_1",
      {
        metadata: {
          opendevhub: {
            spec: { change: "add-login", phase: "implement" },
            task: "tsk_1",
          },
          x: 1,
        },
      },
      "/workspaces/wt"
    );
    expect(client.command).toHaveBeenCalledWith(
      "ses_1",
      "opsx-apply",
      "add-login",
      "/workspaces/wt"
    );
    expect(client.updateSession.mock.invocationCallOrder[0]).toBeLessThan(
      client.command.mock.invocationCallOrder[0]
    );
    expect(reconcile).toHaveBeenCalledWith("p");
  });

  it("refuses an unfinished or unknown change, and an invalid one unless forced", async () => {
    const unfinished = make({
      outputs: [report(STATUS, VALID)],
      sessions: [taskSession({ phase: "propose" })],
    });
    await expect(
      unfinished.specs.approve("p", "/workspaces/wt", "add-login")
    ).rejects.toThrow("tasks not done");

    const unknown = make({
      outputs: [section("list", list("other"))],
      sessions: [taskSession({ phase: "propose" })],
    });
    await expect(
      unknown.specs.approve("p", "/workspaces/wt", "add-login")
    ).rejects.toThrow("no OpenSpec change add-login");

    const invalid = make({
      outputs: [report(READY, INVALID), report(READY, INVALID)],
      sessions: [taskSession({ phase: "propose" })],
    });
    await expect(
      invalid.specs.approve("p", "/workspaces/wt", "add-login")
    ).rejects.toThrow("auth: no scenarios");
    expect(invalid.client.updateSession).not.toHaveBeenCalled();
    await invalid.specs.approve("p", "/workspaces/wt", "add-login", true);
    expect(invalid.client.command).toHaveBeenCalledOnce();

    for (const m of [unfinished, unknown]) {
      expect(m.client.updateSession).not.toHaveBeenCalled();
      expect(m.client.command).not.toHaveBeenCalled();
    }
  });

  it("refuses once approved or while the agent works, and goes back to propose when the command fails", async () => {
    const approved = make({
      outputs: [],
      sessions: [taskSession({ change: "add-login", phase: "implement" })],
    });
    await expect(
      approved.specs.approve("p", "/workspaces/wt", "add-login")
    ).rejects.toThrow("already approved");

    const busy = make({
      outputs: [],
      sessions: [taskSession({ phase: "propose" }, "running")],
    });
    await expect(
      busy.specs.approve("p", "/workspaces/wt", "add-login")
    ).rejects.toThrow("still busy");

    const failing = make({
      outputs: [report(READY, VALID)],
      sessions: [taskSession({ phase: "propose" })],
    });
    failing.client.command.mockRejectedValue(new Error("opencode is down"));
    await expect(
      failing.specs.approve("p", "/workspaces/wt", "add-login")
    ).rejects.toThrow("opencode is down");
    expect(
      failing.client.updateSession.mock.calls.map(
        (c) =>
          (c[1] as { metadata: { opendevhub: { spec: { phase: string } } } })
            .metadata.opendevhub.spec.phase
      )
    ).toStrictEqual(["implement", "propose"]);
  });
});

const done = (name: string) => ({
  changes: [{ completedTasks: 3, name, totalTasks: 3 }],
});
const ARCHIVED = {
  archive: { archivedAs: "2026-10-10-add-login", change: "add-login" },
};
/** What `openspec archive` leaves: the change in the archive, its delta merged into the main spec. */
const archiveOnDisk = async () => {
  const archive = path.join(host, "openspec/changes/archive");
  await fs.mkdir(archive, { recursive: true });
  await fs.rename(
    path.join(host, "openspec/changes/add-login"),
    path.join(archive, "2026-10-10-add-login")
  );
  await fs.writeFile(
    path.join(host, "openspec/specs/auth/spec.md"),
    "## Requirements\n### Requirement: Timeout\nAfter 15 minutes.\n"
  );
};

describe(parseArchive, () => {
  it("reads the archive folder, or the CLI's errors", () => {
    expect(
      parseArchive({ code: 0, text: JSON.stringify(ARCHIVED) })
    ).toStrictEqual({ archived: "2026-10-10-add-login" });
    expect(
      parseArchive({
        code: 1,
        text: JSON.stringify({
          archive: null,
          status: [
            { message: "auth MODIFIED failed", severity: "error" },
            { message: "just so you know", severity: "warning" },
          ],
        }),
      })
    ).toStrictEqual({ error: "auth MODIFIED failed" });
    expect(parseArchive({ code: 1, text: "boom\nreal error" })).toStrictEqual({
      error: "real error",
    });
  });
});

describe("Specs.archive", () => {
  it("archives the finished change with the CLI and records the archived phase", async () => {
    const { client, exec, reconcile, specs } = make({
      outputs: [
        section("list", done("add-login")),
        section("archive", ARCHIVED),
      ],
      sessions: [taskSession({ change: "add-login", phase: "implement" })],
    });
    await specs.archive("p", "/workspaces/wt", "add-login");
    expect(exec.mock.calls.map((c) => c[1].slice(4))).toStrictEqual([
      ["/workspaces/wt", "list", "", "", ""],
      ["/workspaces/wt", "", "", "add-login", "archive"],
    ]);
    expect(client.updateSession).toHaveBeenCalledWith(
      "ses_1",
      {
        metadata: {
          opendevhub: {
            spec: {
              archived: "2026-10-10-add-login",
              change: "add-login",
              phase: "archived",
            },
            task: "tsk_1",
          },
          x: 1,
        },
      },
      "/workspaces/wt"
    );
    expect(client.command).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledWith("p");
  });

  it("refuses before approval, once archived, while the agent works, or with tasks left", async () => {
    const cases: [ReturnType<typeof make>, string][] = [
      [
        make({ outputs: [], sessions: [taskSession({ phase: "propose" })] }),
        "before archiving it",
      ],
      [
        make({
          outputs: [],
          sessions: [taskSession({ change: "add-login", phase: "archived" })],
        }),
        "already archived",
      ],
      [
        make({
          outputs: [],
          sessions: [
            taskSession({ change: "add-login", phase: "implement" }, "running"),
          ],
        }),
        "still busy",
      ],
      [
        make({
          outputs: [section("list", list("add-login"))],
          sessions: [taskSession({ change: "add-login", phase: "implement" })],
        }),
        "1 of 3 tasks are done",
      ],
      [
        make({
          outputs: [section("list", done("other"))],
          sessions: [taskSession({ change: "add-login", phase: "implement" })],
        }),
        "no OpenSpec change add-login",
      ],
    ];
    for (const [m, message] of cases) {
      await expect(
        m.specs.archive("p", "/workspaces/wt", "add-login")
      ).rejects.toThrow(message);
      expect(m.exec.mock.calls.some((c) => c[1].includes("archive"))).toBe(
        false
      );
      expect(m.client.updateSession).not.toHaveBeenCalled();
    }
  });

  it("reports the CLI's error and keeps the phase when archiving fails", async () => {
    const { client, specs } = make({
      outputs: [
        section("list", done("add-login")),
        section(
          "archive",
          {
            archive: null,
            status: [
              {
                message:
                  'auth MODIFIED failed for header "### Requirement: Nope"',
                severity: "error",
              },
            ],
          },
          1
        ),
      ],
      sessions: [taskSession({ change: "add-login", phase: "implement" })],
    });
    await expect(
      specs.archive("p", "/workspaces/wt", "add-login")
    ).rejects.toThrow("openspec archive failed: auth MODIFIED failed");
    expect(client.updateSession).not.toHaveBeenCalled();
  });

  it("shows the archived change from the archive, with the main specs it updated", async () => {
    await archiveOnDisk();
    const { exec, specs } = make({
      outputs: [section("base", "") + section("list", list("other"))],
      sessions: [
        taskSession({
          archived: "2026-10-10-add-login",
          change: "add-login",
          phase: "archived",
        }),
      ],
    });
    const view = await specs.view("p", "/workspaces/wt");
    // Only the list: the CLI no longer knows the change.
    expect(exec.mock.calls.map((c) => c[1].slice(4))).toStrictEqual([
      ["/workspaces/wt", "list", "base", "", ""],
    ]);
    expect(view.change).toMatchObject({
      archived: "2026-10-10-add-login",
      name: "add-login",
      planningComplete: true,
      updatedSpecs: [
        {
          content:
            "## Requirements\n### Requirement: Timeout\nAfter 15 minutes.\n",
          path: "auth/spec.md",
        },
      ],
    });
    // The main spec already has the change, so there's no before to compare with.
    expect(view.change?.requirements).toStrictEqual([
      {
        capability: "auth",
        delta: "### Requirement: Timeout\nAfter 15 minutes.",
        name: "Timeout",
        operation: "MODIFIED",
      },
    ]);
  });

  it("finds the change in the archive before the task's phase says so", async () => {
    await archiveOnDisk();
    const { specs } = make({
      outputs: [
        section("base", "") +
          section("list", list("other")) +
          section("status", "change not found", 1) +
          section("validate", "change not found", 1),
      ],
      sessions: [taskSession({ change: "add-login", phase: "implement" })],
    });
    const view = await specs.view("p", "/workspaces/wt");
    expect(view.change?.archived).toBe("2026-10-10-add-login");
  });
});
