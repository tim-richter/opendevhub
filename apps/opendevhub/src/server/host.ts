import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { NodeId } from "../shared/types";
import { type Runner, spawnRunner } from "./exec";

export const LOCAL_NODE: NodeId = "local";

/** A machine opendevhub runs commands on and connects into: this one, or a node over ssh. */
export interface Host {
  id: NodeId;
  run: Runner;
  /** A TCP connection to `ip:port` as that machine sees it. */
  dial(ip: string, port: number): Promise<Duplex>;
  readFile(file: string): Promise<string>;
  /** Creates missing parent folders. */
  writeFile(file: string, content: string): Promise<void>;
}

export function connectTcp(ip: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: ip, port, allowHalfOpen: true });
    socket.once("error", reject);
    socket.once("connect", () => {
      socket.off("error", reject);
      resolve(socket);
    });
  });
}

export function localHost(run: Runner = spawnRunner): Host {
  return {
    id: LOCAL_NODE,
    run,
    dial: connectTcp,
    readFile: (file) => fs.readFile(file, "utf8"),
    async writeFile(file, content) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    },
  };
}
