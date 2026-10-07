import net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { CommandError } from "../../src/server/containers";
import {
  GATEWAY_LABEL,
  GATEWAY_NAME,
  Gateway,
  parseGatewayInspect,
} from "../../src/server/gateway";
import { RelayError } from "../../src/server/relay/client";
import { fakeRunner } from "../helpers/fake-runner";
import type { Call } from "../helpers/fake-runner";
import { freePort, startRelay } from "../helpers/relay";

type Relay = Awaited<ReturnType<typeof startRelay>>;
const relays: Relay[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(relays.splice(0).map((r) => r.stop()));
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r)))
  );
});

function inspectJson(o: {
  running?: boolean;
  version?: string;
  token?: string;
  hostPort?: number;
}) {
  return JSON.stringify({
    State: { Running: o.running ?? true },
    Config: {
      Labels: o.version ? { [GATEWAY_LABEL]: o.version } : {},
      Env: [
        "PATH=/usr/bin",
        ...(o.token ? [`ODH_RELAY_TOKEN=${o.token}`] : []),
        "ODH_RELAY_REMOTE=1",
      ],
    },
    NetworkSettings: {
      Ports: o.hostPort
        ? {
            "4097/tcp": [{ HostIp: "127.0.0.1", HostPort: String(o.hostPort) }],
          }
        : {},
    },
  });
}

/** A fake docker CLI whose `run` starts a real relay in remote mode, standing in for the gateway container. */
function fakeDocker(opts: { networkError?: string } = {}) {
  const state: {
    container?: { relay: Relay; version: string; token: string };
  } = {};
  const { run, calls } = fakeRunner(async (c: Call) => {
    const [sub] = c.args;
    if (sub === "inspect") {
      if (!state.container) {
        return {
          exitCode: 1,
          stderr: `Error: No such container: ${GATEWAY_NAME}`,
        };
      }
      const { relay, version, token } = state.container;
      return {
        stdout: `${inspectJson({ version, token, hostPort: relay.port })}\n`,
      };
    }
    if (sub === "rm") {
      await state.container?.relay.stop();
      state.container = undefined;
      return {};
    }
    if (sub === "run") {
      const token = c.opts?.env?.ODH_RELAY_TOKEN ?? "";
      const relay = await startRelay(token, { ODH_RELAY_REMOTE: "1" });
      relays.push(relay);
      const version = c.args[c.args.indexOf("--label") + 1].split("=")[1];
      state.container = { relay, version, token };
      return { stdout: "f00d\n" };
    }
    if (sub === "network") {
      return opts.networkError
        ? { exitCode: 1, stderr: opts.networkError }
        : {};
    }
    return {};
  });
  return { run, calls, state };
}

async function echo(prefix = "echo:"): Promise<number> {
  const server = net.createServer((s) =>
    s.on("data", (d) => s.write(prefix + d.toString()))
  );
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as net.AddressInfo).port;
}

function exchange(socket: net.Socket, message: string): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (d) => {
      resolve(d.toString());
      socket.destroy();
    });
    socket.resume(); // handed over paused, like a relay connection
    socket.write(message);
  });
}

const container = { id: "c1", ip: "127.0.0.1", network: "proj_default" };
const sub = (calls: Call[], name: string) =>
  calls.filter((c) => c.args[0] === name);

describe(parseGatewayInspect, () => {
  it("reads state, version label, token and the published port", () => {
    expect(
      parseGatewayInspect(
        inspectJson({ version: "v1", token: "t", hostPort: 55_001 })
      )
    ).toStrictEqual({
      running: true,
      version: "v1",
      token: "t",
      hostPort: 55_001,
    });
  });

  it("tolerates missing labels, env and ports", () => {
    expect(
      parseGatewayInspect(
        JSON.stringify({
          State: { Running: false },
          Config: { Labels: null, Env: null },
        })
      )
    ).toStrictEqual({
      running: false,
      version: undefined,
      token: undefined,
      hostPort: undefined,
    });
  });
});

describe(Gateway, () => {
  it("creates the gateway on first use, keeping the token off the command line", async () => {
    const docker = fakeDocker();
    const gateway = new Gateway({ run: docker.run });
    const logs: string[] = [];
    await gateway.attach(container, (l) => logs.push(l));

    const [runCall] = sub(docker.calls, "run");
    expect(runCall.args).toStrictEqual(
      expect.arrayContaining([
        "--name",
        GATEWAY_NAME,
        "-p",
        "127.0.0.1::4097",
        "-e",
        "ODH_RELAY_TOKEN",
        "node:22-alpine",
      ])
    );
    expect(runCall.args.join(" ")).not.toContain(docker.state.container!.token);
    expect(runCall.opts?.env?.ODH_RELAY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(logs).toContain(
      "network: starting the gateway container (node:22-alpine)"
    );
    expect(sub(docker.calls, "network").map((c) => c.args)).toStrictEqual([
      ["network", "connect", "proj_default", GATEWAY_NAME],
    ]);
  });

  it("connects to container ports through the gateway", async () => {
    const docker = fakeDocker();
    const gateway = new Gateway({ run: docker.run });
    await gateway.attach(container, () => {});
    const port = await echo("app:");
    await expect(
      exchange(await gateway.connect("127.0.0.1", port), "hi")
    ).resolves.toBe("app:hi");
  });

  it("keeps bytes the upstream sends right after OK", async () => {
    const server = net.createServer((s) => s.write("banner"));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as net.AddressInfo;
    const gateway = new Gateway({ run: fakeDocker().run });
    const socket = await gateway.connect("127.0.0.1", port);
    const got = await new Promise<string>((resolve) =>
      socket.once("data", (d) => resolve(d.toString())).resume()
    );
    socket.destroy();
    expect(got).toBe("banner");
  });

  it("reports a refused container port as a RelayError", async () => {
    const gateway = new Gateway({ run: fakeDocker().run });
    await expect(
      gateway.connect("127.0.0.1", await freePort())
    ).rejects.toStrictEqual(new RelayError("ECONNREFUSED"));
  });

  it("reuses a running gateway of the current version", async () => {
    const docker = fakeDocker();
    await new Gateway({ run: docker.run }).attach(container, () => {});
    const again = new Gateway({ run: docker.run });
    await again.attach(container, () => {});
    expect(sub(docker.calls, "run")).toHaveLength(1);
    expect(sub(docker.calls, "rm")).toHaveLength(0);
  });

  it("replaces a gateway from another version or image", async () => {
    const docker = fakeDocker();
    await new Gateway({ run: docker.run }).attach(container, () => {});
    await new Gateway({ run: docker.run, image: "node:24-alpine" }).attach(
      container,
      () => {}
    );
    expect(sub(docker.calls, "rm").map((c) => c.args)).toStrictEqual([
      ["rm", "-f", GATEWAY_NAME],
    ]);
    expect(sub(docker.calls, "run")).toHaveLength(2);
    expect(sub(docker.calls, "run")[1].args).toContain("node:24-alpine");
  });

  it("joins each network once and accepts one it is already on", async () => {
    const docker = fakeDocker({
      networkError:
        "Error response from daemon: endpoint with name opendevhub-gateway already exists in network bridge",
    });
    const gateway = new Gateway({ run: docker.run });
    await gateway.attach(
      { id: "a", ip: "127.0.0.1", network: "bridge" },
      () => {}
    );
    await gateway.attach(
      { id: "b", ip: "127.0.0.1", network: "bridge" },
      () => {}
    );
    expect(sub(docker.calls, "network")).toHaveLength(1);
  });

  it("fails attach when the network cannot be joined", async () => {
    const gateway = new Gateway({
      run: fakeDocker({ networkError: "network proj_default not found" }).run,
    });
    await expect(gateway.attach(container, () => {})).rejects.toBeInstanceOf(
      CommandError
    );
  });

  it("recreates a gateway that went away and rejoins its networks", async () => {
    const docker = fakeDocker();
    const gateway = new Gateway({ run: docker.run });
    await gateway.attach(container, () => {});
    // Simulate `docker rm -f` behind our back (or Docker restarting).
    await docker.state.container!.relay.stop();
    docker.state.container = undefined;

    const port = await echo("back:");
    await expect(
      exchange(await gateway.connect("127.0.0.1", port), "x")
    ).resolves.toBe("back:x");
    expect(sub(docker.calls, "run")).toHaveLength(2);
    expect(sub(docker.calls, "network")).toHaveLength(2);
  });

  it("explains a gateway that does not answer, with its logs", async () => {
    const { run } = fakeRunner((c) => {
      if (c.args[0] === "inspect") {
        return {
          stdout: inspectJson({ version: "x", token: "t", hostPort: 1 }),
        };
      }
      if (c.args[0] === "logs") {
        return { stderr: "exec format error\n" };
      }
      return {};
    });
    const gateway = new Gateway({
      run,
      ping: async () => false,
      readyTimeoutMs: 50,
      readyIntervalMs: 10,
    });
    const err = await gateway
      .attach(container, () => {})
      .catch((error: unknown) => error);
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).message).toBe(
      "the gateway container did not answer"
    );
    expect((err as CommandError).tail).toStrictEqual(["exec format error"]);
  });
});
