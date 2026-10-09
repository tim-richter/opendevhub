import net from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  RelayError,
  openRelayConnection,
  pingRelay,
} from "../../../../src/server/network/relay/client";
import { freePort, startRelay } from "../../../helpers/relay";

let relay: Awaited<ReturnType<typeof startRelay>>;
const servers: net.Server[] = [];
beforeEach(async () => {
  relay = await startRelay("secret");
});
afterEach(async () => {
  await relay.stop();
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(r)))
  );
});

describe("relay client", () => {
  it("pings with the right token and fails with the wrong one or no relay", async () => {
    await expect(
      pingRelay({ host: "127.0.0.1", port: relay.port, token: "secret" })
    ).resolves.toBeTruthy();
    await expect(
      pingRelay({ host: "127.0.0.1", port: relay.port, token: "wrong" }, 300)
    ).resolves.toBeFalsy();
    await expect(
      pingRelay(
        { host: "127.0.0.1", port: await freePort(), token: "secret" },
        300
      )
    ).resolves.toBeFalsy();
  });

  it("opens a piped connection after OK, handing over early upstream bytes", async () => {
    const port = await freePort();
    const banner = net.createServer((c) => c.write("hello-banner"));
    servers.push(banner);
    await new Promise<void>((r) => banner.listen(port, "127.0.0.1", r));
    const { socket, rest } = await openRelayConnection(
      { host: "127.0.0.1", port: relay.port, token: "secret" },
      port
    );
    const later = await new Promise<string>((resolve) => {
      if (rest.length) {
        return resolve(rest.toString());
      }
      socket.once("data", (d) => resolve(d.toString()));
      socket.resume();
    });
    expect(later).toBe("hello-banner");
    socket.destroy();
  });

  it("rejects with RelayError(ECONNREFUSED) when nothing listens in the container", async () => {
    const err = await openRelayConnection(
      { host: "127.0.0.1", port: relay.port, token: "secret" },
      await freePort()
    ).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(RelayError);
    expect((err as RelayError).code).toBe("ECONNREFUSED");
  });

  it("rejects with a plain error when the relay is unreachable", async () => {
    const err = await openRelayConnection(
      { host: "127.0.0.1", port: await freePort(), token: "secret" },
      80
    ).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RelayError);
  });
});
