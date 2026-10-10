import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { NotFoundError } from "../../../src/server/errors";
import {
  GitSetupProbe,
  parseKeyLines,
  sshOption,
  sshRemote,
} from "../../../src/server/git/setup";
import type { RunOptions, RunResult } from "../../../src/server/nodes/exec";
import type { Project } from "../../../src/shared/types";

const result = (stdout: string, exitCode = 0): RunResult => ({
  exitCode,
  stderr: "",
  stdout,
  timedOut: false,
});

const ED25519 = "256 SHA256:aaaa dev@laptop (ED25519)";
const RSA = "4096 SHA256:bbbb dev@work (RSA)";

describe("sshRemote", () => {
  it("reads scp-like and ssh:// remotes, and skips the rest", () => {
    expect(sshRemote("git@code.example.com:me/app.git")).toStrictEqual({
      hostname: "code.example.com",
      port: "22",
      user: "git",
    });
    expect(sshRemote("ssh://git@git.internal:2222/me/app.git")).toStrictEqual({
      hostname: "git.internal",
      port: "2222",
      user: "git",
    });
    expect(sshRemote("myalias:me/app.git")).toStrictEqual({
      hostname: "myalias",
      port: "22",
    });
    expect(sshRemote("https://code.example.com/me/app.git")).toBeUndefined();
    expect(sshRemote("/srv/git/app.git")).toBeUndefined();
  });
});

describe("parsing", () => {
  it("reads ssh-add and ssh-keygen key lines", () => {
    expect(parseKeyLines(`${ED25519}\n${RSA}\n`)).toStrictEqual([
      {
        bits: 256,
        comment: "dev@laptop",
        fingerprint: "SHA256:aaaa",
        type: "ED25519",
      },
      {
        bits: 4096,
        comment: "dev@work",
        fingerprint: "SHA256:bbbb",
        type: "RSA",
      },
    ]);
    expect(parseKeyLines("The agent has no identities.")).toStrictEqual([]);
  });

  it("reads ssh -G options", () => {
    const out =
      "user git\nidentityfile ~/.ssh/id_ed25519\nidentityfile ~/.ssh/id_rsa\n";
    expect(sshOption(out, "identityfile")).toStrictEqual([
      "~/.ssh/id_ed25519",
      "~/.ssh/id_rsa",
    ]);
    expect(sshOption(out, "user")).toStrictEqual(["git"]);
  });
});

describe("GitSetupProbe", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "odh-git-setup-"));
  const ssh = path.join(home, ".ssh");
  fs.mkdirSync(ssh);
  for (const name of [
    "id_ed25519",
    "id_ed25519.pub",
    "work_rsa",
    "work_rsa.pub",
  ]) {
    fs.writeFileSync(path.join(ssh, name), "");
  }
  const projects: Project[] = [
    { devcontainerPath: "", id: "web", name: "web", path: "/code/web" },
    {
      devcontainerPath: "",
      id: "billing",
      name: "billing",
      path: "/code/billing",
    },
  ];

  const probe = (calls: string[][] = []) =>
    new GitSetupProbe({
      home,
      projects: () => projects,
      run: async (cmd: string, args: string[], opts?: RunOptions) => {
        calls.push([cmd, ...args]);
        const key = [cmd, ...args].join(" ");
        if (cmd === "git") {
          if (key === "git --version") {
            return result("git version 2.49.0\n");
          }
          if (key === "git remote -v") {
            return opts?.cwd === "/code/web"
              ? result(
                  "origin\tgit@code.example.com:me/web.git (fetch)\norigin\tgit@code.example.com:me/web.git (push)\n"
                )
              : result(
                  "origin\thttps://code.example.com/me/billing.git (fetch)\n"
                );
          }
          if (key === "git config --get user.name") {
            return result("Dev\n");
          }
          if (key === "git config --get user.email") {
            return result(
              opts?.cwd === "/code/billing"
                ? "dev@work.example\n"
                : "dev@example.com\n"
            );
          }
          return result("", 1);
        }
        if (cmd === "ssh-add") {
          return result(`${ED25519}\n`);
        }
        if (cmd === "ssh-keygen" && args[0] === "-l") {
          return result(args[2]?.includes("work_rsa") ? RSA : ED25519);
        }
        if (cmd === "ssh-keygen" && args[0] === "-F") {
          return result("code.example.com ssh-ed25519 AAAA\n");
        }
        if (cmd === "ssh" && args[0] === "-G") {
          return result(
            "user git\nidentityfile ~/.ssh/id_ed25519\nidentityfile ~/.ssh/id_missing\n"
          );
        }
        return result("", 255);
      },
    });

  it("reports identity, agent keys, key files and each host's key", async () => {
    const view = await probe().view();
    expect(view.version).toBe("2.49.0");
    expect(view.identity).toStrictEqual({
      email: "dev@example.com",
      name: "Dev",
    });
    expect(view.agent).toStrictEqual({
      keys: parseKeyLines(ED25519),
      running: true,
    });
    expect(view.keyFiles.map((k) => k.path)).toStrictEqual([
      path.join(ssh, "id_ed25519"),
      path.join(ssh, "work_rsa"),
    ]);
    expect(view.hosts).toStrictEqual([
      {
        host: "code.example.com",
        identityFiles: [
          { exists: true, inAgent: true, path: path.join(ssh, "id_ed25519") },
        ],
        known: true,
        projects: ["web"],
        user: "git",
      },
    ]);
    expect(view.projects).toStrictEqual([
      {
        identity: { email: "dev@work.example", name: "Dev" },
        project: "billing",
        projectId: "billing",
      },
    ]);
  });

  it("tests only hosts that a project's remote points at", async () => {
    const calls: string[][] = [];
    const p = probe(calls);
    await expect(p.test("evil.example.com")).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(calls.some(([cmd, arg]) => cmd === "ssh" && arg === "-T")).toBe(
      false
    );
    await expect(p.test("code.example.com")).resolves.toStrictEqual({
      message: "exit 255",
      ok: false,
    });
    expect(calls.at(-1)).toStrictEqual([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      "-p",
      "22",
      "-l",
      "git",
      "--",
      "code.example.com",
    ]);
  });
});
