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
    startSession: vi.fn(async () => "ses_1"),
    openInEditor: vi.fn(async () => {}),
    replyPermission: vi.fn(async (_id: string, _rid: string, _reply: { decision: string; message?: string }) => {}),
    replyForm: vi.fn(async (_id: string, _fid: string, _answer: unknown) => {}),
    cancelForm: vi.fn(async (_id: string, _fid: string) => {}),
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
    expect(orchestrator.removeWorktree).toHaveBeenCalledWith(project.id, "/p", false);
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
});
