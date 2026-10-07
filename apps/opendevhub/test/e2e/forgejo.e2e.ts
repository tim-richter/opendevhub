import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { spawnRunner } from "../../src/server/exec";
import { Publisher } from "../../src/server/publish";
import { MemorySecretStore } from "../helpers/secrets";
import { FileForgejoSettings, Forgejo } from "../../src/server/forgejo";
import type { Project } from "../../src/shared/types";

const enabled = process.env.OPENDEVHUB_E2E && process.env.OPENDEVHUB_E2E_FORGEJO;
const IMAGE = process.env.OPENDEVHUB_FORGEJO_IMAGE ?? "codeberg.org/forgejo/forgejo:11";
const USER = "odh";
const PASS = "odh-e2e-password-1";

describe.skipIf(!enabled)("e2e: Forgejo publishing and PR dashboard", () => {
  it("publishes private PRs, updates them, loads their diffs and filters by state", async () => {
    const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8" }).trim();
    const id = docker("run", "-d", "-p", "127.0.0.1::3000", "-e", "FORGEJO__security__INSTALL_LOCK=true", "-e", "FORGEJO__database__DB_TYPE=sqlite3", IMAGE);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "odh-forgejo-"));
    try {
      const port = docker("port", id, "3000/tcp").split(":").at(-1)!;
      const web = `http://127.0.0.1:${port}`;
      const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");
      for (let i = 0; i < 60; i++) {
        if (await fetch(`${web}/api/forgejo/v1/version`).then((r) => r.ok, () => false)) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      docker("exec", "-u", "git", id, "forgejo", "admin", "user", "create", "--username", USER, "--password", PASS, "--email", "odh@example.com", "--admin", "--must-change-password=false");
      const created = await fetch(`${web}/api/v1/user/repos`, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ name: "demo", private: true }),
      });
      expect(created.ok).toBe(true);

      const repo = path.join(tmp, "demo");
      const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      fs.mkdirSync(repo);
      git("init", "-q", "-b", "main");
      git("config", "user.name", "e2e");
      git("config", "user.email", "e2e@example.com");
      fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
      git("add", "-A");
      git("commit", "-q", "-m", "init");
      git("remote", "add", "origin", `http://${USER}:${PASS}@127.0.0.1:${port}/${USER}/demo.git`);
      git("push", "-q", "origin", "main", "main:refs/heads/release/1.0");
      // Forgejo clears the repo's "empty" flag asynchronously after the first push; AGit is refused until it does.
      for (let i = 0; i < 30; i++) {
        const info = (await (await fetch(`${web}/api/v1/repos/${USER}/demo`, { headers: { authorization: auth } })).json()) as { empty: boolean };
        if (!info.empty) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      git("checkout", "-q", "-b", "feature/agit");
      fs.writeFileSync(path.join(repo, "b.txt"), "b\n");
      git("add", "-A");
      git("commit", "-q", "-m", "feat: b");

      const project: Project = { id: "forgejo", name: "forgejo", path: repo, devcontainerPath: "" };
      const publisher = new Publisher({
        containers: { exec: () => Promise.reject(new Error("no container in this test")) },
        run: spawnRunner,
        forges: { all: () => ({ "127.0.0.1": { kind: "forgejo", web } }), remember: () => {} },
      });
      const checkout = { container: repo, host: repo };
      const pulls = async () =>
        (await (await fetch(`${web}/api/v1/repos/${USER}/demo/pulls?state=open`, { headers: { authorization: auth } })).json()) as Array<{
          title: string;
          base: { ref: string };
          html_url: string;
        }>;

      const first = await publisher.publish(project, checkout, "feature/agit", { remote: "origin", base: "main", strategy: "agit", title: "Add b", description: "Adds b." });
      console.log("[e2e forgejo] first publish:", first.output.join("\n"));
      expect(await pulls()).toHaveLength(1);
      expect((await pulls())[0].title).toBe("Add b");
      expect(first.prUrl).toMatch(/\/pulls\/\d+$/);

      fs.writeFileSync(path.join(repo, "c.txt"), "c\n");
      git("add", "-A");
      git("commit", "-q", "-m", "feat: c");
      await publisher.publish(project, checkout, "feature/agit", { remote: "origin", base: "main", strategy: "agit", title: "Add b", description: "Adds b." });
      expect(await pulls()).toHaveLength(1);

      git("checkout", "-q", "-b", "feature/release", "main");
      fs.writeFileSync(path.join(repo, "d.txt"), "d\n");
      git("add", "-A");
      git("commit", "-q", "-m", "fix: d");
      await publisher.publish(project, checkout, "feature/release", { remote: "origin", base: "release/1.0", strategy: "agit", title: "Fix d", description: "" });
      expect((await pulls()).map((p) => p.base.ref).sort()).toEqual(["main", "release/1.0"]);

      // The dashboard integration uses a read-only token independently of git's publishing credentials.
      const tokenResponse = await fetch(`${web}/api/v1/users/${USER}/tokens`, {
        method: "POST", headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ name: "dashboard-reader", scopes: ["read:user", "read:repository", "read:issue"] }),
      });
      expect(tokenResponse.ok).toBe(true);
      const token = (await tokenResponse.json()) as { sha1: string };
      const settings = new FileForgejoSettings(tmp, new MemorySecretStore());
      await settings.save({ enabled: true, url: web, token: token.sha1 });
      const forgejo = new Forgejo(settings);
      const open = await forgejo.pulls();
      expect(open.username).toBe(USER);
      expect(open.pulls).toHaveLength(2);
      const addB = open.pulls.find((p) => p.title === "Add b")!;
      const diff = await forgejo.diff(addB.owner, addB.repo, String(addB.number));
      expect(diff.patch).toContain("+b");
      expect(diff.patch).toContain("+c");
      expect(diff).toMatchObject({ head: "refs/pull/1/head", base: "main" });
      const closed = await fetch(`${web}/api/v1/repos/${USER}/demo/pulls/${addB.number}`, {
        method: "PATCH", headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ state: "closed" }),
      });
      expect(closed.ok).toBe(true);
      expect((await forgejo.pulls("open")).pulls).toHaveLength(1);
      expect((await forgejo.pulls()).pulls).toHaveLength(2);
      expect((await forgejo.pulls("closed")).pulls[0]).toMatchObject({ number: addB.number, state: "closed" });
    } finally {
      docker("rm", "-f", id);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
