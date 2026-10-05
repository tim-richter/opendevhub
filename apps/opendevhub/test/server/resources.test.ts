import { describe, expect, it } from "vitest";
import { parseStats, sampleResources } from "../../src/server/resources";
import { fakeRunner } from "../helpers/fake-runner";

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const line = (id: string, cpu: string, mem: string) => JSON.stringify({ ID: id, CPUPerc: cpu, MemUsage: mem, Name: "x" });
const FULL_A = "aaaaaaaaaaaa" + "0".repeat(52);
const FULL_B = "bbbbbbbbbbbb" + "0".repeat(52);

describe("parseStats", () => {
  it("reads CPU and memory with binary units, rounded", () => {
    const stats = parseStats(`${line("aaaaaaaaaaaa", "12.6%", "1.248GiB / 31.24GiB")}\n`);
    expect(stats.get("aaaaaaaaaaaa")).toEqual({
      cpu: 13,
      memory: Math.round((1.248 * GiB) / MiB) * MiB,
      memoryLimit: Math.round((31.24 * GiB) / MiB) * MiB,
    });
  });

  it("accepts B, KiB, MiB, TiB and decimal kB/MB/GB", () => {
    const out = parseStats(
      [
        line("a", "0.00%", "512KiB / 2MiB"),
        line("b", "150.2%", "700MB / 1TiB"),
        line("c", "1%", "3000000kB / 4GB"),
        line("d", "1%", "1048576B / 8GiB"),
      ].join("\n"),
    );
    expect(out.get("a")).toEqual({ cpu: 0, memory: 1 * MiB, memoryLimit: 2 * MiB });
    expect(out.get("b")).toEqual({ cpu: 150, memory: Math.round(700e6 / MiB) * MiB, memoryLimit: 1024 ** 4 });
    expect(out.get("c")?.memory).toBe(Math.round(3e9 / MiB) * MiB);
    expect(out.get("d")?.memory).toBe(MiB);
  });

  it("skips stopping containers and lines that don't parse", () => {
    const out = parseStats(
      [
        line("a", "--", "-- / --"),
        line("b", "1%", "0B / 0B"),
        line("c", "", "1MiB / 2MiB"),
        "not json",
        "{broken",
        JSON.stringify({ ID: "", CPUPerc: "1%", MemUsage: "1MiB / 2MiB" }),
        line("ok", "2%", "1MiB / 2MiB"),
      ].join("\n"),
    );
    expect([...out.keys()]).toEqual(["ok"]);
  });
});

describe("sampleResources", () => {
  it("makes no docker call when nothing runs", async () => {
    const { run, calls } = fakeRunner();
    expect(await sampleResources(run, [])).toEqual({});
    expect(calls).toHaveLength(0);
  });

  it("asks docker for all containers at once and matches short ids to environments", async () => {
    const { run, calls } = fakeRunner(() => ({
      stdout: `${line("aaaaaaaaaaaa", "5%", "1GiB / 2GiB")}\n${line("bbbbbbbbbbbb", "7%", "1MiB / 2GiB")}\n`,
    }));
    const out = await sampleResources(run, [
      { envId: "proj", containerId: FULL_A },
      { envId: "env-1", containerId: FULL_B },
    ]);
    expect(calls[0].cmd).toBe("docker");
    expect(calls[0].args).toEqual(["stats", "--no-stream", "--format", "{{json .}}", FULL_A, FULL_B]);
    expect(calls[0].opts?.timeoutMs).toBe(15_000);
    expect(out).toEqual({
      proj: { cpu: 5, memory: GiB, memoryLimit: 2 * GiB },
      "env-1": { cpu: 7, memory: MiB, memoryLimit: 2 * GiB },
    });
  });

  it("retries once without a container that is gone", async () => {
    const { run, calls } = fakeRunner((c) =>
      c.args.includes(FULL_B)
        ? { exitCode: 1, stderr: "Error response from daemon: No such container: " + FULL_B }
        : { stdout: line("aaaaaaaaaaaa", "5%", "1GiB / 2GiB") },
    );
    const out = await sampleResources(run, [
      { envId: "proj", containerId: FULL_A },
      { envId: "env-1", containerId: FULL_B },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[1].args.slice(4)).toEqual([FULL_A]);
    expect(Object.keys(out)).toEqual(["proj"]);
  });

  it("returns nothing when docker fails for another reason or times out", async () => {
    const failing = fakeRunner(() => ({ exitCode: 1, stderr: "Cannot connect to the Docker daemon" }));
    expect(await sampleResources(failing.run, [{ envId: "p", containerId: FULL_A }])).toEqual({});
    expect(failing.calls).toHaveLength(1);
    const slow = fakeRunner(() => ({ exitCode: 1, timedOut: true }));
    expect(await sampleResources(slow.run, [{ envId: "p", containerId: FULL_A }])).toEqual({});
  });
});
