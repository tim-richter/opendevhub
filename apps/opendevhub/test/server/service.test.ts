import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { RunResult, Runner } from "../../src/server/nodes/exec";
import {
  LAUNCHD_LABEL,
  SYSTEMD_UNIT,
  launchdPlist,
  launcherProblem,
  runServiceCommand,
  serviceEnv,
  serviceFile,
  systemdUnit,
} from "../../src/server/service";
import type { ServiceDeps, ServiceSpec } from "../../src/server/service";

const spec: ServiceSpec = {
  env: { PATH: "/usr/bin:/bin" },
  logFile: "/home/u/.local/state/opendevhub/service.log",
  node: "/usr/bin/node",
  port: 7777,
  script: "/usr/lib/node_modules/opendevhub/dist/bin.js",
};

const ok: RunResult = { exitCode: 0, stderr: "", stdout: "", timedOut: false };

const harness = (
  platform: NodeJS.Platform,
  answer: (cmd: string, args: string[]) => Partial<RunResult> = () => ({})
) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "odh-service-"));
  const calls: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return { ...ok, ...answer(cmd, args) };
  };
  const ports: (number | undefined)[] = [];
  const deps: ServiceDeps = {
    home,
    out: { error: (s) => errors.push(s), log: (s) => logs.push(s) },
    platform,
    run,
    spec: (port) => {
      ports.push(port);
      return {
        ...spec,
        logFile: path.join(home, "state", "service.log"),
        port: port ?? spec.port,
      };
    },
    uid: 501,
  };
  return {
    calls,
    deps,
    errors,
    file: serviceFile(platform, home),
    logs,
    ports,
  };
};

describe(serviceEnv, () => {
  it("keeps PATH, docker and opendevhub settings but not dev switches", () => {
    expect(
      serviceEnv({
        DOCKER_HOST: "unix:///run/user/1000/docker.sock",
        EDITOR: "vim",
        OPENDEVHUB_DEV: "1",
        OPENDEVHUB_ROUTE: "gateway",
        PATH: "/bin",
        XDG_STATE_HOME: "",
      })
    ).toStrictEqual({
      DOCKER_HOST: "unix:///run/user/1000/docker.sock",
      OPENDEVHUB_ROUTE: "gateway",
      PATH: "/bin",
    });
  });
});

describe(launcherProblem, () => {
  it("accepts an installed bin", () => {
    expect(launcherProblem(spec.script)).toBeUndefined();
  });

  it.each([
    "/home/u/.npm/_npx/abc/node_modules/opendevhub/dist/bin.js",
    "/home/u/.cache/pnpm/dlx/abc/node_modules/opendevhub/dist/bin.js",
    "/home/u/opendevhub/apps/opendevhub/src/server/bin.ts",
  ])("rejects %s", (script) => {
    expect(launcherProblem(script)).toBeDefined();
  });
});

describe(systemdUnit, () => {
  it("quotes arguments and keeps % and $ literal", () => {
    const unit = systemdUnit({
      ...spec,
      env: { PATH: '/opt/100%/bin:$HOME/"x"' },
      script: "/opt/my apps/bin.js",
    });
    expect(unit).toContain(
      'ExecStart="/usr/bin/node" "/opt/my apps/bin.js" "--no-open" "--port" "7777"'
    );
    expect(unit).toContain('Environment="PATH=/opt/100%%/bin:$$HOME/\\"x\\""');
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe(launchdPlist, () => {
  it("escapes XML and logs to the state dir", () => {
    const plist = launchdPlist({ ...spec, env: { PATH: "/a&b" } });
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<key>PATH</key><string>/a&amp;b</string>");
    expect(plist).toContain(`<string>${spec.logFile}</string>`);
    expect(plist).toContain("<string>--no-open</string>");
  });
});

describe(runServiceCommand, () => {
  it("installs and starts a systemd user unit", async () => {
    const h = harness("linux");
    expect(await runServiceCommand(["install", "--port", "8080"], h.deps)).toBe(
      0
    );
    expect(h.ports).toStrictEqual([8080]);
    expect(fs.readFileSync(h.file, "utf-8")).toContain('"--port" "8080"');
    expect(h.calls).toStrictEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable ${SYSTEMD_UNIT}`,
      `systemctl --user restart ${SYSTEMD_UNIT}`,
    ]);
  });

  it("reports a failing systemctl", async () => {
    const h = harness("linux", (_cmd, args) =>
      args.includes("restart") ? { exitCode: 1, stderr: "no bus" } : {}
    );
    expect(await runServiceCommand(["install"], h.deps)).toBe(2);
    expect(h.errors[0]).toContain("no bus");
  });

  it("replaces a loaded launchd agent on install", async () => {
    const h = harness("darwin");
    expect(await runServiceCommand(["install"], h.deps)).toBe(0);
    expect(h.file).toBe(
      path.join(
        h.deps.home,
        "Library",
        "LaunchAgents",
        `${LAUNCHD_LABEL}.plist`
      )
    );
    expect(h.calls).toStrictEqual([
      `launchctl bootout gui/501/${LAUNCHD_LABEL}`,
      `launchctl bootstrap gui/501 ${h.file}`,
    ]);
  });

  it("uninstalls and removes the unit", async () => {
    const h = harness("linux");
    await runServiceCommand(["install"], h.deps);
    h.calls.length = 0;
    expect(await runServiceCommand(["uninstall"], h.deps)).toBe(0);
    expect(fs.existsSync(h.file)).toBe(false);
    expect(h.calls).toStrictEqual([
      `systemctl --user disable --now ${SYSTEMD_UNIT}`,
      "systemctl --user daemon-reload",
    ]);
  });

  it("shows the unit's state", async () => {
    const h = harness("linux", () => ({ exitCode: 3, stdout: "inactive\n" }));
    await runServiceCommand(["status"], h.deps);
    expect(h.logs[0]).toBe(
      "not installed. Install it: opendevhub service install"
    );
    fs.mkdirSync(path.dirname(h.file), { recursive: true });
    fs.writeFileSync(h.file, "");
    await runServiceCommand(["status"], h.deps);
    expect(h.logs[1]).toBe(`inactive (${h.file})`);
  });

  it("reads the launchd agent's state", async () => {
    const h = harness("darwin", () => ({
      stdout: "gui/501/dev.opendevhub = {\n\tstate = running\n}",
    }));
    fs.mkdirSync(path.dirname(h.file), { recursive: true });
    fs.writeFileSync(h.file, "");
    await runServiceCommand(["status"], h.deps);
    expect(h.logs[0]).toBe(`running (${h.file})`);
  });

  it.each([[[]], [["start"]], [["install", "--port", "0"]]])(
    "rejects %j",
    async (argv) => {
      const h = harness("linux");
      expect(await runServiceCommand(argv, h.deps)).toBe(2);
      expect(h.calls).toStrictEqual([]);
    }
  );

  it("refuses other platforms", async () => {
    const h = harness("win32");
    expect(await runServiceCommand(["install"], h.deps)).toBe(2);
    expect(h.errors[0]).toContain("Linux");
  });
});
