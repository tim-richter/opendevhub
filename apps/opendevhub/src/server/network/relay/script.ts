/**
 * Runs inside the container (Bun via `BUN_BE_BUN=1 <opencode> -e`, or Node) and relays TCP from
 * 0.0.0.0:$ODH_RELAY_PORT to the container's loopback. Protocol: see the container relay spec §3.
 * With ODH_RELAY_REMOTE=1 it is the gateway (see gateway.ts) and also accepts `<token> <ip> <port>`,
 * connecting to that IP instead of loopback.
 * `agent-listen` / `agent-accept <id>` forward the host's ssh-agent: the relay serves a unix socket at
 * $ODH_AGENT_SOCK and hands each client to opendevhub (see the git and ssh credentials spec §1).
 * Constraints: CommonJS, node:net/node:crypto/node:fs only, no single quotes (it is shell-quoted as one arg).
 */
export const RELAY_SCRIPT = `/*odh-relay*/
"use strict";
const net = require("node:net");
const crypto = require("node:crypto");
const fs = require("node:fs");
const token = process.env.ODH_RELAY_TOKEN || "";
const port = Number(process.env.ODH_RELAY_PORT || "4097");
const remote = process.env.ODH_RELAY_REMOTE === "1";
const agentPath = process.env.ODH_AGENT_SOCK || "/tmp/opendevhub-ssh-agent.sock";
if (!token) {
  console.error("odh-relay: ODH_RELAY_TOKEN is not set");
  process.exit(2);
}
const expected = Buffer.from(token);
function tokenOk(candidate) {
  const b = Buffer.from(candidate);
  return b.length === expected.length && crypto.timingSafeEqual(b, expected);
}
function connectTo(hosts, target, done) {
  const codes = [];
  const attempt = (i) => {
    if (i >= hosts.length) {
      return done(codes.includes("ECONNREFUSED") ? "ECONNREFUSED" : codes[codes.length - 1] || "EUNKNOWN");
    }
    const s = net.connect({ host: hosts[i], port: target, allowHalfOpen: true });
    const onError = (err) => {
      codes.push(err.code || "EUNKNOWN");
      s.destroy();
      attempt(i + 1);
    };
    s.once("error", onError);
    s.once("connect", () => {
      s.off("error", onError);
      done(null, s);
    });
  };
  attempt(0);
}
const agent = { server: null, control: null, closeTimer: null, nextId: 1, pending: new Map() };
function announce(id) {
  if (agent.control) agent.control.write("CONN " + id + "\\n");
}
function closeAgent() {
  if (agent.server) {
    agent.server.close();
    agent.server = null;
    try { fs.unlinkSync(agentPath); } catch (e) {}
  }
  for (const p of agent.pending.values()) {
    clearTimeout(p.timer);
    p.client.destroy();
  }
  agent.pending.clear();
}
function onAgentClient(c) {
  if (!agent.control) return c.destroy();
  const id = agent.nextId++;
  c.pause();
  c.on("error", () => c.destroy());
  const timer = setTimeout(() => {
    agent.pending.delete(id);
    c.destroy();
  }, 5000);
  agent.pending.set(id, { client: c, timer });
  c.once("close", () => {
    const p = agent.pending.get(id);
    if (p && p.client === c) {
      clearTimeout(timer);
      agent.pending.delete(id);
    }
  });
  announce(id);
}
function listenAgent(conn) {
  if (agent.closeTimer) {
    clearTimeout(agent.closeTimer);
    agent.closeTimer = null;
  }
  const previous = agent.control;
  agent.control = conn;
  if (previous) previous.destroy();
  conn.on("error", () => conn.destroy());
  conn.on("end", () => conn.destroy());
  conn.on("data", () => {});
  conn.on("close", () => {
    if (agent.control !== conn) return;
    agent.control = null;
    agent.closeTimer = setTimeout(() => {
      agent.closeTimer = null;
      if (!agent.control) closeAgent();
    }, 2000);
  });
  conn.resume();
  const ready = () => {
    conn.write("OK\\n");
    for (const id of agent.pending.keys()) announce(id);
  };
  if (agent.server) return ready();
  try { fs.unlinkSync(agentPath); } catch (e) {}
  const server = net.createServer({ allowHalfOpen: true }, onAgentClient);
  agent.server = server;
  const umask = process.umask(0o177);
  server.on("error", (err) => {
    process.umask(umask);
    console.error("odh-relay: agent socket: " + err.message);
    if (agent.server === server) agent.server = null;
    conn.end("ERR " + (err.code || "EUNKNOWN") + "\\n");
  });
  server.listen(agentPath, () => {
    process.umask(umask);
    try { fs.chmodSync(agentPath, 0o600); } catch (e) {}
    if (agent.control === conn) ready();
  });
}
function acceptAgent(conn, idArg, rest) {
  const id = /^[0-9]+$/.test(idArg) ? Number(idArg) : -1;
  const p = agent.pending.get(id);
  if (!p) return conn.end("ERR ENOENT\\n");
  clearTimeout(p.timer);
  agent.pending.delete(id);
  const c = p.client;
  const close = () => {
    c.destroy();
    conn.destroy();
  };
  c.on("close", close);
  conn.on("close", close);
  conn.on("error", close);
  conn.write("OK\\n");
  if (rest.length) c.write(rest);
  c.pipe(conn);
  conn.pipe(c);
  c.resume();
  conn.resume();
}
const server = net.createServer({ allowHalfOpen: true }, (client) => {
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => client.destroy(), 5000);
  client.on("error", () => client.destroy());
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(10);
    if (nl === -1 || nl > 256) {
      if (nl > 256 || buf.length > 256) {
        clearTimeout(timer);
        client.destroy();
      }
      return;
    }
    clearTimeout(timer);
    client.off("data", onData);
    client.pause();
    const parts = buf.subarray(0, nl).toString("utf8").trim().split(" ");
    const rest = buf.subarray(nl + 1);
    if (parts.length < 2 || !tokenOk(parts[0])) return client.destroy();
    if (parts[1] === "agent-listen" || parts[1] === "agent-accept") {
      if (remote) return client.destroy();
      if (parts[1] === "agent-listen" && parts.length === 2) return listenAgent(client);
      if (parts[1] === "agent-accept" && parts.length === 3) return acceptAgent(client, parts[2], rest);
      return client.destroy();
    }
    if (parts.length > (remote ? 3 : 2)) return client.destroy();
    if (parts.length === 2 && parts[1] === "ping") return client.end("PONG 2\\n");
    const hosts = parts.length === 3 ? [parts[1]] : ["127.0.0.1", "::1"];
    if (parts.length === 3 && !net.isIP(parts[1])) return client.destroy();
    const portArg = parts[parts.length - 1];
    if (!/^[0-9]+$/.test(portArg)) return client.destroy();
    const target = Number(portArg);
    if (target < 1 || target > 65535) return client.destroy();
    connectTo(hosts, target, (code, upstream) => {
      if (code) return client.end("ERR " + code + "\\n");
      if (client.destroyed) return upstream.destroy();
      const close = () => {
        client.destroy();
        upstream.destroy();
      };
      upstream.on("error", close);
      upstream.on("close", close);
      client.on("close", close);
      client.write("OK\\n");
      if (rest.length) upstream.write(rest);
      client.pipe(upstream);
      upstream.pipe(client);
    });
  };
  client.on("data", onData);
});
server.on("error", (err) => {
  console.error("odh-relay: " + err.message);
  process.exit(1);
});
server.listen(port, "0.0.0.0", () => console.log("odh-relay listening on " + port));
`;
