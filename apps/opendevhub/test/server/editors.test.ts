import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  EditorLauncher,
  EditorUnavailableError,
  attachedContainerUri,
  detectEditors,
  pathWhich,
} from "../../src/server/editors";
import type { Spawner } from "../../src/server/editors";

const which = (installed: Record<string, string>) => async (names: string[]) =>
  names.map((n) => installed[n]).find(Boolean);

const target = {
  containerPath: "/workspaces/demo.worktrees/x",
  hostPath: "/src/demo.worktrees/x",
  containerName: "demo_c1",
};

describe(attachedContainerUri, () => {
  it("hex-encodes the container name JSON the Dev Containers extension expects", () => {
    const uri = attachedContainerUri("demo_c1", "/workspaces/demo");
    const hex = uri.slice(
      "vscode-remote://attached-container+".length,
      uri.indexOf("/workspaces")
    );
    expect(JSON.parse(Buffer.from(hex, "hex").toString("utf-8"))).toStrictEqual(
      {
        containerName: "/demo_c1",
      }
    );
    expect(uri.endsWith("/workspaces/demo")).toBeTruthy();
    expect(attachedContainerUri("c", "/workspaces/my app")).toMatch(
      /\/workspaces\/my%20app$/u
    );
  });
});

describe(detectEditors, () => {
  it("lists only what is installed, VS Code twice (container and local)", async () => {
    const editors = await detectEditors(
      which({
        code: "/usr/bin/code",
        webstorm: "/opt/ws",
        zeditor: "/usr/bin/zeditor",
      }),
      {}
    );
    expect(editors.map(({ id, target: t }) => [id, t])).toStrictEqual([
      ["vscode-container", "container"],
      ["vscode", "host"],
      ["zed", "host"],
      ["jetbrains-webstorm", "host"],
    ]);
    expect(editors.find((e) => e.id === "zed")?.build(target)).toStrictEqual({
      cmd: "/usr/bin/zeditor",
      args: ["--new", "/src/demo.worktrees/x"],
      cwd: "/src/demo.worktrees/x",
    });
    const vsc = editors[0].build(target);
    expect(vsc?.args[0]).toBe("--folder-uri");
    expect(vsc?.args[1]).toMatch(
      /^vscode-remote:\/\/attached-container\+[0-9a-f]+\/workspaces\/demo\.worktrees\/x$/u
    );
  });

  it("can't open host editors without a host path or attach without a container", async () => {
    const editors = await detectEditors(which({ code: "/usr/bin/code" }), {});
    expect(editors[0].build({ containerPath: "/w" })).toBeUndefined();
    expect(
      editors[1].build({ containerPath: "/w", containerName: "c" })
    ).toBeUndefined();
  });

  it("runs nvim in $TERMINAL, falling back to a known terminal", async () => {
    const both = which({
      nvim: "/usr/bin/nvim",
      kitty: "/usr/bin/kitty",
      foot: "/usr/bin/foot",
    });
    const viaEnv = (await detectEditors(both, { TERMINAL: "foot" })).find(
      (e) => e.id === "nvim-terminal"
    );
    expect(viaEnv?.label).toBe("Neovim (foot)");
    expect(viaEnv?.build(target)?.args).toStrictEqual([
      "--working-directory=/src/demo.worktrees/x",
      "/usr/bin/nvim",
      ".",
    ]);
    const fallback = (await detectEditors(both, {})).find(
      (e) => e.id === "nvim-terminal"
    );
    expect(fallback?.build(target)).toStrictEqual({
      cmd: "/usr/bin/kitty",
      args: ["--directory", "/src/demo.worktrees/x", "/usr/bin/nvim", "."],
      cwd: "/src/demo.worktrees/x",
    });
    const unknownTerm = which({
      nvim: "/usr/bin/nvim",
      myterm: "/usr/bin/myterm",
    });
    expect(
      (await detectEditors(unknownTerm, { TERMINAL: "myterm" }))
        .at(-1)
        ?.build(target)?.args
    ).toStrictEqual(["-e", "/usr/bin/nvim", "."]);
    expect(
      (await detectEditors(which({ nvim: "/usr/bin/nvim" }), {})).some(
        (e) => e.id === "nvim-terminal"
      )
    ).toBeFalsy();
  });
});

describe(pathWhich, () => {
  it("finds executables on PATH and ignores non-executables", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-which-"));
    try {
      fs.writeFileSync(path.join(dir, "tool"), "#!/bin/sh\n", { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "plain"), "", { mode: 0o644 });
      const w = pathWhich({ PATH: dir });
      await expect(w(["missing", "tool"])).resolves.toBe(
        path.join(dir, "tool")
      );
      if (process.getuid?.() !== 0) {
        await expect(w(["plain"])).resolves.toBeUndefined();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stderr: PassThrough;
    unref: () => void;
  };
  child.stderr = new PassThrough();
  child.unref = vi.fn();
  return child;
}

describe(EditorLauncher, () => {
  const launcher = async (
    child: ReturnType<typeof fakeChild>,
    settleMs = 30
  ) => {
    const spawner = vi.fn(() => child) as unknown as Spawner &
      ReturnType<typeof vi.fn>;
    const editors = await detectEditors(which({ code: "/usr/bin/code" }), {});
    return { spawner, l: new EditorLauncher(editors, spawner, settleMs) };
  };

  it("spawns detached and resolves once the editor keeps running", async () => {
    const child = fakeChild();
    const { spawner, l } = await launcher(child);
    await l.open("vscode", target);
    expect(spawner).toHaveBeenCalledWith(
      "/usr/bin/code",
      ["--new-window", "/src/demo.worktrees/x"],
      expect.objectContaining({ detached: true, cwd: "/src/demo.worktrees/x" })
    );
    expect(child.unref).toHaveBeenCalled();
  });

  it("reports a quick non-zero exit with the last stderr line", async () => {
    const child = fakeChild();
    const { l } = await launcher(child, 1000);
    const p = l.open("vscode", target);
    child.stderr.write("noise\ncannot open display\n");
    setTimeout(() => child.emit("exit", 1), 5);
    await expect(p).rejects.toThrow(
      "VS Code exited with code 1: cannot open display"
    );
  });

  it("rejects unknown editors and impossible targets up front", async () => {
    const { l } = await launcher(fakeChild());
    expect(() => l.open("emacs", target)).toThrow(EditorUnavailableError);
    expect(() => l.open("vscode", { containerPath: "/w" })).toThrow(
      /only exists inside the container/u
    );
    expect(() => l.open("vscode-container", { containerPath: "/w" })).toThrow(
      /needs a running container/u
    );
    expect(l.list().map((e) => e.id)).toStrictEqual([
      "vscode-container",
      "vscode",
    ]);
  });
});
