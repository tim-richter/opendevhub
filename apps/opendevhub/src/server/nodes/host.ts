import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";

import type { NodeId } from "../../shared/types";
import { spawnRunner } from "./exec";
import type { Runner } from "./exec";

export const LOCAL_NODE: NodeId = "local";

/** A machine opendevhub runs commands on and connects into: this one, or a node over ssh. */
export interface Host {
  id: NodeId;
  run: Runner;
  /** A TCP connection to `ip:port` as that machine sees it. */
  dial: (ip: string, port: number) => Promise<Duplex>;
  readFile: (file: string) => Promise<string>;
  /** Creates missing parent folders. */
  writeFile: (file: string, content: string) => Promise<void>;
  /** The absolute home folder on that machine; opendevhub's files on a node go under `<home>/.opendevhub`. */
  home: string;
}

export const connectTcp = (ip: string, port: number): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ allowHalfOpen: true, host: ip, port });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });

export const localHost = (run: Runner = spawnRunner): Host => ({
  dial: connectTcp,
  home: os.homedir(),
  id: LOCAL_NODE,
  readFile: (file) => fs.readFile(file, "utf-8"),
  run,
  async writeFile(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  },
});
