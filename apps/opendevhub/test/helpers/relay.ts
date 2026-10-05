import { spawn } from "node:child_process";
import net from "node:net";
import { RELAY_SCRIPT } from "../../src/server/relay/script";

export function freePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, host, () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

export async function startRelay(token = "tok", env: Record<string, string> = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["-e", RELAY_SCRIPT], {
    env: { ...process.env, ODH_RELAY_PORT: String(port), ODH_RELAY_TOKEN: token, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d: Buffer) => (out += d.toString()));
  child.stderr.on("data", (d: Buffer) => (out += d.toString()));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`relay did not start: ${out}`)), 5000);
    const check = () => {
      if (out.includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on("data", check);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited with ${code}: ${out}`));
    });
  });
  return {
    port,
    output: () => out,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}
