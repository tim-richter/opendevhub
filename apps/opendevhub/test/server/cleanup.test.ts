import { describe, expect, it } from "vitest";
import { FRESH_IMAGE_MS, staleDocker } from "../../src/server/cleanup";
import type { ContainerInfo, ImageInfo } from "../../src/server/containers";

const NOW = Date.parse("2026-10-05T12:00:00Z");
const OLD = NOW - 2 * FRESH_IMAGE_MS;
const img = (id: string, refs: string[], extra: Partial<ImageInfo> = {}): ImageInfo => ({ id, refs, bytes: 100, created: OLD, labels: {}, ...extra });
const ctr = (id: string, extra: Partial<ContainerInfo>): ContainerInfo => ({ id, name: `n-${id}`, running: false, ...extra });

function stale(o: { containers?: ContainerInfo[]; images?: ImageInfo[]; envs?: string[]; refs?: string[] }) {
  return staleDocker({
    containers: o.containers ?? [],
    images: o.images ?? [],
    projects: new Set(["demo"]),
    hasEnv: (id) => (o.envs ?? []).includes(id),
    recordedRefs: new Set(o.refs ?? []),
    now: NOW,
  });
}

describe("staleDocker containers", () => {
  it("lists task containers without a record, and containers of removed projects", () => {
    const items = stale({
      containers: [
        ctr("c1", { envId: "demo-x", envProjectId: "demo" }),
        ctr("c2", { envId: "gone-y", envProjectId: "gone" }),
        ctr("c3", { envId: "gone-z", envProjectId: "gone", running: true }),
        ctr("c4", { projectId: "gone" }),
        ctr("c5", { projectId: "demo" }),
        ctr("c6", { envId: "demo-ok", envProjectId: "demo" }),
      ],
      envs: ["demo-ok", "gone-z"],
    });
    expect(items.map((i) => [i.id, i.kind === "container" && i.why, i.checked])).toEqual([
      ["container:c1", "orphan-env", true],
      ["container:c2", "orphan-env", true],
      ["container:c3", "removed-project", false],
      ["container:c4", "removed-project", true],
    ]);
    expect(items[0]).toMatchObject({ kind: "container", containerId: "c1", name: "n-c1", running: false, projectId: "demo" });
  });
});

describe("staleDocker images", () => {
  it("lists superseded bases, images of removed projects and unused labelled UID images", () => {
    const items = stale({
      images: [
        img("sha256:old", ["opendevhub/demo:111111111111-base"]),
        img("sha256:cur", ["opendevhub/demo:222222222222-base"]),
        img("sha256:gone", ["opendevhub/gone:333333333333-base"]),
        img("sha256:uid", ["vsc-demo-feat-abc-uid:latest"], { labels: { "opendevhub.base-project": "demo" } }),
        img("sha256:dangling", [], { labels: { "opendevhub.base-project": "demo" } }),
      ],
      refs: ["opendevhub/demo:222222222222-base"],
    });
    expect(items.map((i) => [i.id, i.kind === "image" && i.why, i.checked])).toEqual([
      ["image:opendevhub/demo:111111111111-base", "superseded", true],
      ["image:opendevhub/gone:333333333333-base", "removed-project", true],
      ["image:vsc-demo-feat-abc-uid:latest", "uid", true],
    ]);
    expect(items[0]).toMatchObject({ ref: "opendevhub/demo:111111111111-base", bytes: 100, projectId: "demo" });
  });

  it("keeps images a kept container runs, and offers ones only stale containers run", () => {
    const items = stale({
      containers: [ctr("keep", { projectId: "demo", imageId: "sha256:a" }), ctr("orphan", { envId: "demo-x", envProjectId: "demo", imageId: "sha256:b" })],
      images: [
        img("sha256:a", ["vsc-a-uid:latest"], { labels: { "opendevhub.base-project": "demo" } }),
        img("sha256:b", ["vsc-b-uid:latest"], { labels: { "opendevhub.base-project": "demo" } }),
      ],
    });
    expect(items.map((i) => i.id)).toEqual(["container:orphan", "image:vsc-b-uid:latest"]);
  });

  it("never offers an image created in the last 15 minutes", () => {
    const items = stale({ images: [img("sha256:new", ["opendevhub/demo:444444444444-base"], { created: NOW - 60_000 })] });
    expect(items).toEqual([]);
  });

  it("ignores opendevhub images that aren't bases of a current project", () => {
    expect(stale({ images: [img("sha256:x", ["opendevhub/demo:something"])] })).toEqual([]);
  });
});
