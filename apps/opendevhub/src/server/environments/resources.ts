import type { EnvId, ResourceStats } from "../../shared/types";
import type { Runner } from "../nodes/exec";
import type { StateStore } from "../projects/state";

const STATS_TIMEOUT_MS = 15_000;
const MiB = 1024 ** 2;

const UNITS: Record<string, number> = {
  b: 1,
  gb: 1e9,
  gib: 1024 ** 3,
  kb: 1e3,
  kib: 1024,
  mb: 1e6,
  mib: MiB,
  tb: 1e12,
  tib: 1024 ** 4,
};

/** `"1.248GiB"` in bytes; docker uses binary units for memory, and decimal ones on some platforms. */
const parseSize = (text: string): number | undefined => {
  const m = /^(?<g1>[\d.]+)\s*(?<g2>[a-z]*)$/iu.exec(text.trim());
  if (!m) {
    return undefined;
  }
  const unit = UNITS[(m[2] || "b").toLowerCase()];
  const n = Number(m[1]);
  return unit !== undefined && Number.isFinite(n) ? n * unit : undefined;
};

const roundMiB = (bytes: number) => Math.round(bytes / MiB) * MiB;

/** `docker stats --format '{{json .}}'` output by the short id docker prints; containers mid-stop are left out. */
export const parseStats = (stdout: string): Map<string, ResourceStats> => {
  const out = new Map<string, ResourceStats>();
  for (const raw of stdout.split(/\r?\n/u)) {
    const text = raw.trim();
    if (!text.startsWith("{")) {
      continue;
    }
    let row: { ID?: unknown; CPUPerc?: unknown; MemUsage?: unknown };
    try {
      row = JSON.parse(text) as typeof row;
    } catch {
      continue;
    }
    if (
      typeof row.ID !== "string" ||
      row.ID === "" ||
      typeof row.CPUPerc !== "string" ||
      typeof row.MemUsage !== "string"
    ) {
      continue;
    }
    const cpu = /^(?<g1>[\d.]+)%$/u.exec(row.CPUPerc.trim());
    const [used, limit] = row.MemUsage.split("/").map(parseSize);
    if (!cpu || used === undefined || !limit) {
      continue;
    }
    out.set(row.ID, {
      cpu: Math.round(Number(cpu[1])),
      memory: roundMiB(used),
      memoryLimit: roundMiB(limit),
    });
  }
  return out;
};

export interface RunningContainer {
  envId: EnvId;
  containerId: string;
}

const sameContainer = (a: string, b: string) =>
  a.startsWith(b) || b.startsWith(a);

/** Every running environment's load from one `docker stats` call; nothing when docker fails. */
export const sampleResources = async (
  run: Runner,
  running: RunningContainer[]
): Promise<Record<EnvId, ResourceStats>> => {
  let targets = running;
  for (let attempt = 0; attempt < 2 && targets.length > 0; attempt += 1) {
    const r = await run(
      "docker",
      [
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
        ...targets.map((t) => t.containerId),
      ],
      {
        timeoutMs: STATS_TIMEOUT_MS,
      }
    );
    if (r.exitCode === 0 && !r.timedOut) {
      const rows = [...parseStats(r.stdout)];
      const out: Record<EnvId, ResourceStats> = {};
      for (const t of targets) {
        const hit = rows.find(([id]) => sameContainer(t.containerId, id));
        if (hit) {
          [, out[t.envId]] = hit;
        }
      }
      return out;
    }
    // One container that is gone fails the whole call: drop the ones docker names and try once more.
    const gone = [...r.stderr.matchAll(/No such container: (?<g1>\S+)/gu)].map(
      (m) => m[1]
    );
    if (gone.length === 0) {
      break;
    }
    targets = targets.filter(
      (t) => !gone.some((g) => sameContainer(t.containerId, g))
    );
  }
  return {};
};

export interface SamplerOptions {
  run: Runner;
  store: Pick<StateStore, "runningContainers" | "setResources">;
  intervalMs?: number;
}

/** Samples now and then `intervalMs` after each round ends, so slow `docker stats` calls never overlap. */
export const startResourceSampler = (
  opts: SamplerOptions
): { stop: () => void } => {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const round = async () => {
    const stats = await sampleResources(
      opts.run,
      opts.store.runningContainers()
    ).catch(() => ({}));
    if (stopped) {
      return;
    }
    opts.store.setResources(stats);
    timer = setTimeout(() => void round(), opts.intervalMs ?? 5000);
  };
  void round();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
};
