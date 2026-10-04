import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDashboardApp, type DashboardOrchestrator } from "../../src/server/dashboard-api";
import { CommandError } from "../../src/server/containers";
import { EditorUnavailableError } from "../../src/server/editors";
import { AlreadyAnsweredError, BusyError, NotFoundError, UnavailableError } from "../../src/server/orchestrator";
import { InvalidRequestError } from "../../src/server/worktrees";
import { StateStore } from "../../src/server/state";
import type { Project } from "../../src/shared/types";

const project: Project = { id: "demo-abc123", name: "demo", path: "/src/demo", devcontainerPath: "/x" };

function setup(webDir?: string) {
  const store = new StateStore({ port: 7777, persisted: { projects: {} }, persist: () => {} });
  store.setProjects([project]);
  store.updateRuntime(project.id, { password: "secret" });
  const orchestrator = {
    start: vi.fn(() => Promise.resolve()),
    stop: vi.fn(() => Promise.resolve()),
    rebuild: vi.fn(() => Promise.resolve()),
    restartOpencode: vi.fn(() => Promise.resolve()),
    rescan: vi.fn(async () => {}),
    logLines: vi.fn(() => ["a", "b"]),
    onLog: vi.fn(() => () => {}),
    refreshWorktrees: vi.fn(async () => []),
    createWorktree: vi.fn(async () => ({ worktree: { path: "/workspaces/demo.worktrees/x", branch: "x" } })),
    removeWorktree: vi.fn(async () => {}),
    startSession: vi.fn(async (_id: string, _dir: string, _title?: string, _prompt?: string) => "ses_1"),
    openInEditor: vi.fn(async () => {}),
    replyPermission: vi.fn(async (_id: string, _rid: string, _reply: { decision: string; message?: string }) => {}),
    replyForm: vi.fn(async (_id: string, _fid: string, _answer: unknown) => {}),
    cancelForm: vi.fn(async (_id: string, _fid: string) => {}),
    review: vi.fn(async (_id: string, directory: string, _o?: { base?: string; file?: string }) => ({
      directory,
      mode: "branch" as const,
      ahead: 0,
      behind: 0,
      dirty: false,
      pushed: false,
      workspace: { clean: true },
      files: [],
    })),
    promptSession: vi.fn(async (_id: string, _sid: string, _text: string) => {}),
    commitMessage: vi.fn(async (_id: string, _dir: string) => "feat: x"),
    commit: vi.fn(async (_id: string, _dir: string, _m: string) => {}),
    updateFromBase: vi.fn(async (_id: string, _dir: string, _base: string) => ({ strategy: "rebase" as const })),
    mergeIntoBase: vi.fn(async (_id: string, _dir: string, _base: string, _ff: boolean) => ({ branch: "x" })),
    publishInfo: vi.fn(async (_id: string, _dir: string, _remote?: string) => ({
      remotes: ["origin"],
      remote: "origin",
      forge: { kind: "unknown" as const },
      strategies: ["branch" as const],
      strategy: "branch" as const,
      pushFrom: "host" as const,
    })),
    publishSuggestion: vi.fn(async (_id: string, _dir: string) => ({ title: "t", description: "d" })),
    publish: vi.fn(async (_id: string, _dir: string, _req: unknown) => ({ strategy: "branch" as const, pushedFrom: "host" as const, output: [] })),
  } satisfies DashboardOrchestrator;
  return { store, orchestrator, app: createDashboardApp({ store, orchestrator, webDir }) };
}

describe("dashboard API", () => {
  it("GET /api/projects returns the snapshot without passwords", async () => {
    const { app } = setup();
    const res = await app.request("/api/projects");
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("secret");
    expect(JSON.parse(text).projects[0].project.id).toBe(project.id);
  });

  it.each([
    ["start", "start"],
    ["stop", "stop"],
    ["rebuild", "rebuild"],
    ["restart-opencode", "restartOpencode"],
  ] as const)("POST %s triggers orchestrator.%s", async (route, method) => {
    const { app, orchestrator } = setup();
    const res = await app.request(`/api/projects/${project.id}/${route}`, { method: "POST" });
    expect(res.status).toBe(202);
    expect(orchestrator[method]).toHaveBeenCalledWith(project.id);
  });

  it("maps BusyError to 409 and NotFoundError to 404", async () => {
    const { app, orchestrator } = setup();
    orchestrator.start.mockImplementationOnce(() => {
      throw new BusyError(project.id);
    });
    expect((await app.request(`/api/projects/${project.id}/start`, { method: "POST" })).status).toBe(409);
    orchestrator.start.mockImplementationOnce(() => {
      throw new NotFoundError("x");
    });
    expect((await app.request(`/api/projects/x/start`, { method: "POST" })).status).toBe(404);
  });

  it("worktree routes pass the JSON body and return the result", async () => {
    const { app, orchestrator } = setup();
    const post = (route: string, body: unknown) =>
      app.request(`/api/projects/${project.id}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const created = await post("worktrees", { branch: "x", base: "main", startSession: true });
    expect(created.status).toBe(200);
    expect(orchestrator.createWorktree).toHaveBeenCalledWith(project.id, { branch: "x", base: "main", startSession: true });
    expect(await created.json()).toMatchObject({ worktree: { branch: "x" } });
    await post("worktrees/remove", { path: "/p", force: "yes" });
    expect(orchestrator.removeWorktree).toHaveBeenCalledWith(project.id, "/p", false, false);
    expect(await (await post("sessions", { directory: "/d" })).json()).toEqual({ sessionId: "ses_1" });
    expect(await (await post("open", { editor: "zed", directory: "/d" })).json()).toEqual({ ok: true });
    expect(orchestrator.openInEditor).toHaveBeenCalledWith(project.id, "zed", "/d");
    expect((await post("worktrees/refresh", {})).status).toBe(200);
  });

  it.each([
    [new InvalidRequestError("bad"), 400],
    [new EditorUnavailableError("no"), 400],
    [new NotFoundError("x"), 404],
    [new BusyError("x"), 409],
    [new UnavailableError("stopped"), 412],
    [new CommandError("git worktree failed: fatal"), 422],
    [new Error("boom"), 500],
  ])("maps %s to %i with its message", async (err, status) => {
    const { app, orchestrator } = setup();
    orchestrator.openInEditor.mockImplementationOnce(() => {
      throw err;
    });
    const res = await app.request(`/api/projects/${project.id}/open`, { method: "POST" });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ error: err.message });
  });

  it("rejects cross-site POST actions with a mismatched Origin", async () => {
    const { app, orchestrator } = setup();
    const res = await app.request(`/api/projects/${project.id}/start`, {
      method: "POST",
      headers: { origin: "http://evil.example", host: "localhost:7777" },
    });
    expect(res.status).toBe(403);
    expect(orchestrator.start).not.toHaveBeenCalled();
  });

  it("allows same-origin POST actions (Origin matches Host)", async () => {
    const { app, orchestrator } = setup();
    const res = await app.request(`/api/projects/${project.id}/start`, {
      method: "POST",
      headers: { origin: "http://localhost:7777", host: "localhost:7777" },
    });
    expect(res.status).toBe(202);
    expect(orchestrator.start).toHaveBeenCalledWith(project.id);
  });

  it("sets X-Frame-Options: DENY on responses", async () => {
    const { app } = setup();
    const res = await app.request("/api/projects");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("refuses actions while preflight has errors", async () => {
    const { app, store, orchestrator } = setup();
    store.setPreflight({ errors: ["Docker daemon is not reachable"] });
    const res = await app.request(`/api/projects/${project.id}/start`, { method: "POST" });
    expect(res.status).toBe(412);
    expect(orchestrator.start).not.toHaveBeenCalled();
  });

  it("rescan re-runs discovery and returns the snapshot", async () => {
    const { app, orchestrator } = setup();
    const res = await app.request("/api/projects/rescan", { method: "POST" });
    expect(res.status).toBe(200);
    expect(orchestrator.rescan).toHaveBeenCalled();
  });

  it("GET logs returns buffered lines", async () => {
    const { app } = setup();
    expect(await (await app.request(`/api/projects/${project.id}/logs`)).json()).toEqual({ lines: ["a", "b"] });
  });

  it("GET /api/events starts with a snapshot event", async () => {
    const { app } = setup();
    const res = await app.request("/api/events");
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain("event: snapshot");
    expect(text).not.toContain("secret");
    await reader.cancel();
  });

  it("serves the SPA with index.html fallback", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-web-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<html>app</html>");
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
    const { app } = setup(dir);
    expect(await (await app.request("/")).text()).toContain("app");
    expect(await (await app.request("/some/route")).text()).toContain("app");
    const js = await app.request("/assets/app.js");
    expect(js.headers.get("content-type")).toContain("text/javascript");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("explains how to build the UI when no webDir is available", async () => {
    const { app } = setup(undefined);
    const res = await app.request("/");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("npm run build");
  });
  describe("responding", () => {
    const send = (app: ReturnType<typeof setup>["app"], method: string, route: string, body: unknown, origin?: string) =>
      app.request(`/api/projects/${project.id}/${route}`, {
        method,
        headers: { "content-type": "application/json", host: "localhost:7777", ...(origin ? { origin } : {}) },
        body: JSON.stringify(body),
      });

    it("forwards permission replies, form answers and dismissals", async () => {
      const { app, orchestrator } = setup();
      expect((await send(app, "POST", "permissions/per_1", { decision: "reject", message: "no" })).status).toBe(200);
      expect(orchestrator.replyPermission).toHaveBeenCalledWith(project.id, "per_1", { decision: "reject", message: "no" });
      expect((await send(app, "POST", "forms/frm_1", { answer: { db: "pg" } })).status).toBe(200);
      expect(orchestrator.replyForm).toHaveBeenCalledWith(project.id, "frm_1", { db: "pg" });
      expect((await send(app, "DELETE", "forms/frm_1", undefined)).status).toBe(200);
      expect(orchestrator.cancelForm).toHaveBeenCalledWith(project.id, "frm_1");
    });

    it("maps unknown ids to 404, already answered to 409 and invalid answers to 400 with the message", async () => {
      const { app, orchestrator } = setup();
      orchestrator.replyPermission.mockRejectedValueOnce(new NotFoundError("per_x", "permission request"));
      expect((await send(app, "POST", "permissions/per_x", { decision: "once" })).status).toBe(404);

      orchestrator.replyPermission.mockRejectedValueOnce(new AlreadyAnsweredError());
      const gone = await send(app, "POST", "permissions/per_1", { decision: "once" });
      expect(gone.status).toBe(409);
      expect(await gone.json()).toEqual({ error: "already answered" });

      orchestrator.replyForm.mockRejectedValueOnce(new InvalidRequestError("db is required"));
      const invalid = await send(app, "POST", "forms/frm_1", { answer: {} });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "db is required" });
    });

    it("blocks cross-site replies", async () => {
      const { app, orchestrator } = setup();
      const res = await send(app, "POST", "permissions/per_1", { decision: "once" }, "http://evil.example");
      expect(res.status).toBe(403);
      expect(orchestrator.replyPermission).not.toHaveBeenCalled();
    });
  });
  describe("review", () => {
    const post = (app: ReturnType<typeof setup>["app"], route: string, body: unknown) =>
      app.request(`/api/projects/${project.id}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    it("serves review data for a directory with an optional base and file", async () => {
      const { app, orchestrator } = setup();
      const res = await app.request(`/api/projects/${project.id}/review?directory=%2Fw%2Fx&base=main&file=a.ts`);
      expect(res.status).toBe(200);
      expect((await res.json()).directory).toBe("/w/x");
      expect(orchestrator.review).toHaveBeenCalledWith(project.id, "/w/x", { base: "main", file: "a.ts" });
      orchestrator.review.mockRejectedValueOnce(new InvalidRequestError("/etc is neither the workspace nor a known worktree"));
      expect((await app.request(`/api/projects/${project.id}/review?directory=%2Fetc`)).status).toBe(400);
    });

    it("runs commit, update and merge, and suggests commit messages", async () => {
      const { app, orchestrator } = setup();
      expect(await (await post(app, "review/commit-message", { directory: "/w" })).json()).toEqual({ message: "feat: x" });
      expect((await post(app, "review/commit", { directory: "/w", message: "m" })).status).toBe(200);
      expect(orchestrator.commit).toHaveBeenCalledWith(project.id, "/w", "m");
      expect(await (await post(app, "review/update", { directory: "/w", base: "main" })).json()).toEqual({ strategy: "rebase" });
      expect(await (await post(app, "review/merge", { directory: "/w", base: "main", ffOnly: true })).json()).toEqual({ branch: "x" });
      expect(orchestrator.mergeIntoBase).toHaveBeenCalledWith(project.id, "/w", "main", true);
      orchestrator.commit.mockRejectedValueOnce(new CommandError("git has no user.name/user.email in the container."));
      const failed = await post(app, "review/commit", { directory: "/w", message: "m" });
      expect(failed.status).toBe(422);
      expect((await failed.json()).error).toMatch(/user\.name/);
    });

    it("prompts a session, starts one with a prompt, and removes a worktree with its branch", async () => {
      const { app, orchestrator } = setup();
      expect((await post(app, "sessions/ses_1/prompt", { text: "fix" })).status).toBe(200);
      expect(orchestrator.promptSession).toHaveBeenCalledWith(project.id, "ses_1", "fix");
      await post(app, "sessions", { directory: "/w", title: "Review", prompt: "look" });
      expect(orchestrator.startSession).toHaveBeenLastCalledWith(project.id, "/w", "Review", "look");
      await post(app, "worktrees/remove", { path: "/w", force: false, deleteBranch: true });
      expect(orchestrator.removeWorktree).toHaveBeenLastCalledWith(project.id, "/w", false, true);
    });
  });
  describe("publish", () => {
    const post = (app: ReturnType<typeof setup>["app"], route: string, body: unknown) =>
      app.request(`/api/projects/${project.id}/${route}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    it("serves publish info, suggestions and publishes", async () => {
      const { app, orchestrator } = setup();
      const info = await app.request(`/api/projects/${project.id}/publish?directory=%2Fw&remote=fork`);
      expect(info.status).toBe(200);
      expect(orchestrator.publishInfo).toHaveBeenCalledWith(project.id, "/w", "fork");
      expect(await (await post(app, "publish/suggest", { directory: "/w" })).json()).toEqual({ title: "t", description: "d" });
      const body = { directory: "/w", remote: "origin", base: "main", strategy: "branch", title: "T", description: "D" };
      expect((await post(app, "publish", body)).status).toBe(200);
      expect(orchestrator.publish).toHaveBeenCalledWith(project.id, "/w", { remote: "origin", base: "main", strategy: "branch", title: "T", description: "D" });
      orchestrator.publish.mockRejectedValueOnce(new CommandError("the remote has commits this branch doesn't; use Update from base, then publish again"));
      const rejected = await post(app, "publish", body);
      expect(rejected.status).toBe(422);
      expect((await rejected.json()).error).toMatch(/Update from base/);
    });
  });
});
