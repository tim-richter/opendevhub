import net from "node:net";

export interface RelayTarget {
  host: string;
  port: number;
  token: string;
}

export class RelayError extends Error {
  constructor(readonly code: string) {
    super(`relay: ${code}`);
    this.name = "RelayError";
  }
}

function handshake(
  target: RelayTarget,
  line: string,
  timeoutMs: number,
): Promise<{ socket: net.Socket; reply: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port, allowHalfOpen: true });
    let buf = Buffer.alloc(0);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", fail);
      socket.off("close", onClose);
    };
    const fail = (err: Error) => {
      cleanup();
      socket.destroy();
      reject(err);
    };
    const onClose = () => fail(new Error("relay closed the connection"));
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(10);
      if (nl === -1) {
        if (buf.length > 256) fail(new Error("relay sent an oversized reply"));
        return;
      }
      cleanup();
      socket.pause();
      resolve({ socket, reply: buf.subarray(0, nl).toString("utf8").trim(), rest: buf.subarray(nl + 1) });
    };
    const timer = setTimeout(() => fail(new Error("relay handshake timed out")), timeoutMs);
    socket.on("data", onData);
    socket.on("error", fail);
    socket.on("close", onClose);
    socket.once("connect", () => socket.write(line));
  });
}

/** The relay's answer to ping; older relays answer a bare PONG and are replaced (they have no agent verbs). */
const PONG = "PONG 2";

export async function pingRelay(target: RelayTarget, timeoutMs = 1000): Promise<boolean> {
  try {
    const { socket, reply } = await handshake(target, `${target.token} ping\n`, timeoutMs);
    socket.destroy();
    return reply === PONG;
  } catch {
    return false;
  }
}

export async function openRelayConnection(
  target: RelayTarget,
  port: number,
  timeoutMs = 5000,
): Promise<{ socket: net.Socket; rest: Buffer }> {
  const { socket, reply, rest } = await handshake(target, `${target.token} ${port}\n`, timeoutMs);
  if (reply === "OK") return { socket, rest };
  socket.destroy();
  throw new RelayError(reply.startsWith("ERR ") ? reply.slice(4) : "EPROTO");
}

/**
 * Opens a connection to `host:port` through a relay running in gateway mode (ODH_RELAY_REMOTE=1).
 * The socket is returned paused; bytes the upstream sent along with the OK are pushed back onto it,
 * so it can be piped as is.
 */
export async function openGatewayConnection(
  target: RelayTarget,
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<net.Socket> {
  const { socket, reply, rest } = await handshake(target, `${target.token} ${host} ${port}\n`, timeoutMs);
  if (reply !== "OK") {
    socket.destroy();
    throw new RelayError(reply.startsWith("ERR ") ? reply.slice(4) : "EPROTO");
  }
  if (rest.length) socket.unshift(rest);
  return socket;
}

/** Opens the relay's agent control connection; resolves after OK with the socket paused and any bytes that came along. */
export async function openAgentControl(target: RelayTarget, timeoutMs = 5000): Promise<{ socket: net.Socket; rest: Buffer }> {
  const { socket, reply, rest } = await handshake(target, `${target.token} agent-listen\n`, timeoutMs);
  if (reply === "OK") return { socket, rest };
  socket.destroy();
  throw new RelayError(reply.startsWith("ERR ") ? reply.slice(4) : "EPROTO");
}

/** Takes the container client the relay announced as `CONN <id>`; the socket is returned paused, ready to pipe. */
export async function acceptAgentConnection(target: RelayTarget, id: number, timeoutMs = 5000): Promise<net.Socket> {
  const { socket, reply, rest } = await handshake(target, `${target.token} agent-accept ${id}\n`, timeoutMs);
  if (reply !== "OK") {
    socket.destroy();
    throw new RelayError(reply.startsWith("ERR ") ? reply.slice(4) : "EPROTO");
  }
  if (rest.length) socket.unshift(rest);
  return socket;
}
