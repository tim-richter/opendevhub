import { describe, expect, it } from "vitest";
import { formatNodeStats, nodeStateLabel, nodesNeedingAttention } from "../../src/web/nodes";

const GiB = 1024 ** 3;

describe("node view helpers", () => {
  it("labels states", () => {
    expect(nodeStateLabel("online")).toBe("Online");
    expect(nodeStateLabel("connecting")).toBe("Connecting…");
    expect(nodeStateLabel("unreachable")).toBe("Unreachable");
    expect(nodeStateLabel("error")).toBe("Needs setup");
  });

  it("formats stats on one line", () => {
    expect(formatNodeStats({ cpus: 8, memTotal: 32 * GiB, memAvailable: 12.5 * GiB, containers: 3 })).toBe(
      "8 CPUs · 12.5 GiB free of 32.0 GiB · 3 containers",
    );
    expect(formatNodeStats({ cpus: 1, memTotal: GiB, memAvailable: 512 * 1024 ** 2, containers: 1 })).toBe(
      "1 CPU · 512 MiB free of 1.0 GiB · 1 container",
    );
    expect(formatNodeStats(undefined)).toBeUndefined();
  });

  it("counts nodes that need attention", () => {
    expect(nodesNeedingAttention(undefined)).toBe(0);
    expect(
      nodesNeedingAttention([
        { id: "local", label: "This machine", state: "online" },
        { id: "a", label: "a", state: "unreachable" },
        { id: "b", label: "b", state: "error" },
        { id: "c", label: "c", state: "connecting" },
      ]),
    ).toBe(2);
  });
});
