import { afterEach, describe, expect, it } from "vitest";

import {
  ConflictError,
  NotFoundError,
  UnavailableError,
} from "../../../src/server/errors";
import { OpencodeClient } from "../../../src/server/opencode/client";
import type { RawSavedPermission } from "../../../src/server/opencode/client";
import { STOPPED_MESSAGE } from "../../../src/server/sessions/saved-permissions";
import { rawSession, startFakeOpencode } from "../../helpers/fake-opencode";
import type { FakeOpencode } from "../../helpers/fake-opencode";
import { project, setup } from "../../helpers/hub";

const rule = (
  id: string,
  projectID: string,
  action: string,
  resource: string
): RawSavedPermission => ({
  action,
  id,
  projectID,
  resource,
  time: { created: 10, updated: 20 },
});

describe("saved permissions", () => {
  let fake: FakeOpencode | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  async function running(version = "2.1.0") {
    const s = setup();
    await s.hub.environments.rescan();
    await s.hub.environments.start(project.id);
    s.store.updateRuntime(project.id, { opencodeVersion: version });
    fake = await startFakeOpencode("pw", {
      version,
      projects: ["prj_demo", "prj_other"],
      saved: [
        rule("per_1", "prj_demo", "bash", "pnpm *"),
        rule("per_2", "prj_demo", "edit", "src/**"),
        rule("per_3", "prj_other", "bash", "rm *"),
      ],
      sessions: [
        rawSession("ses_1", { projectID: "prj_demo" }),
        rawSession("ses_x", {
          location: { directory: "/elsewhere" },
          projectID: "prj_other",
        }),
      ],
    });
    const real = new OpencodeClient({ baseUrl: fake.baseUrl, password: "pw" });
    s.clientFor.mockImplementation(() => real);
    return { ...s, fake };
  }

  it("lists the rules of the workspace's opencode project", async () => {
    const { hub } = await running();
    await expect(
      hub.permissions.list(project.id, project.id)
    ).resolves.toStrictEqual({
      canEdit: true,
      rules: [
        {
          action: "bash",
          createdAt: 10,
          id: "per_1",
          resource: "pnpm *",
          updatedAt: 20,
        },
        {
          action: "edit",
          createdAt: 10,
          id: "per_2",
          resource: "src/**",
          updatedAt: 20,
        },
      ],
    });
  });

  it("lists every known project's rules before the environment has a session", async () => {
    const { hub, fake: oc } = await running();
    oc.state.sessions = [];
    const { rules } = await hub.permissions.list(project.id, project.id);
    expect(rules.map((r) => r.id)).toStrictEqual(["per_1", "per_2", "per_3"]);
  });

  it("edits a rule on opencode 2.1", async () => {
    const { hub, fake: oc } = await running();
    await expect(
      hub.permissions.update(project.id, project.id, "per_1", {
        resource: "pnpm test *",
      })
    ).resolves.toMatchObject({ id: "per_1", resource: "pnpm test *" });
    expect(oc.state.saved?.[0].resource).toBe("pnpm test *");
    await expect(
      hub.permissions.update(project.id, project.id, "per_3", { action: "x" })
    ).rejects.toThrow(NotFoundError);
  });

  it("refuses to edit on opencode 2.0.x, where rules can only be removed", async () => {
    const { hub, fake: oc } = await running("2.0.32");
    await expect(
      hub.permissions.list(project.id, project.id)
    ).resolves.toMatchObject({ canEdit: false });
    await expect(
      hub.permissions.update(project.id, project.id, "per_1", {
        action: "edit",
      })
    ).rejects.toThrow(ConflictError);
    expect(oc.requests.some((r) => r.startsWith("PATCH"))).toBe(false);
    await hub.permissions.remove(project.id, project.id, "per_1");
    expect(oc.state.saved?.map((r) => r.id)).toStrictEqual(["per_2", "per_3"]);
  });

  it("counts a rule that is gone already as removed, and never removes another project's", async () => {
    const { hub, fake: oc } = await running();
    await expect(
      hub.permissions.remove(project.id, project.id, "per_gone")
    ).resolves.toBeUndefined();
    await hub.permissions.remove(project.id, project.id, "per_3");
    expect(oc.state.saved?.map((r) => r.id)).toStrictEqual([
      "per_1",
      "per_2",
      "per_3",
    ]);
    await hub.permissions.remove(project.id, project.id, "per_2");
    expect(oc.state.saved?.map((r) => r.id)).toStrictEqual(["per_1", "per_3"]);
    expect(hub.environments.logLines(project.id)).toContain(
      "permissions: removed saved rule edit src/**"
    );
  });

  it("says to start a stopped container, and lists nothing", async () => {
    const { hub, store } = await running();
    store.updateRuntime(project.id, { containerState: "stopped" });
    await expect(
      hub.permissions.list(project.id, project.id)
    ).resolves.toStrictEqual({
      canEdit: true,
      rules: [],
      unavailable: STOPPED_MESSAGE,
    });
    await expect(
      hub.permissions.remove(project.id, project.id, "per_1")
    ).rejects.toThrow(UnavailableError);
  });

  it("refuses an environment of another project", async () => {
    const { hub } = await running();
    await expect(hub.permissions.list(project.id, "env-nope")).rejects.toThrow(
      NotFoundError
    );
  });
});
