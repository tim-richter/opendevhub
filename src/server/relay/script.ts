/**
 * Runs inside the container (Bun via `BUN_BE_BUN=1 <opencode> -e`, or Node) and relays TCP from
 * 0.0.0.0:$ODH_RELAY_PORT to the container's loopback. Protocol: see the container relay spec §3.
 * With ODH_RELAY_REMOTE=1 it is the gateway (see gateway.ts) and also accepts `<token> <ip> <port>`,
 * connecting to that IP instead of loopback.
 * Constraints: CommonJS, node:net/node:crypto only, no single quotes (it is shell-quoted as one arg).
 */
export const RELAY_SCRIPT = `/*odh-relay*/
"use strict";
const net = require("node:net");
const crypto = require("node:crypto");
const token = process.env.ODH_RELAY_TOKEN || "";
const port = Number(process.env.ODH_RELAY_PORT || "4097");
const remote = process.env.ODH_RELAY_REMOTE === "1";
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
    if (parts.length < 2 || parts.length > (remote ? 3 : 2) || !tokenOk(parts[0])) return client.destroy();
    if (parts.length === 2 && parts[1] === "ping") return client.end("PONG\\n");
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
