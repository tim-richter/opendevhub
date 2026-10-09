import { createHash } from "node:crypto";

import type { EnvWorktree, Project } from "../../shared/types";
import type { Runner } from "../nodes/exec";
import type { Containers } from "./containers";

/** What a config's image depends on, besides the key files a project lists. */
export const KEY_PATHS = [".devcontainer", ".devcontainer.json"];

/** On base images, and inherited by the UID images `devcontainer up` builds on them, so cleanup can tell them apart. */
export const BASE_PROJECT_LABEL = "opendevhub.base-project";

export const imageKey = (input: {
  cliVersion: string;
  objects: (string | undefined)[];
  generation: number;
}): string => {
  const parts = [
    input.cliVersion,
    input.objects.map((o) => o ?? null),
    input.generation,
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
};

export const baseImageRef = (projectId: string, key: string): string =>
  `opendevhub/${projectId}:${key.slice(0, 12)}-base`;

export interface ImagesDeps {
  run: Runner;
  containers: Pick<Containers, "imageExists" | "build">;
  /** The object id at HEAD of each path in the worktree (undefined where missing). */
  objects: (
    project: Project,
    worktree: EnvWorktree,
    paths: string[]
  ) => Promise<(string | undefined)[]>;
}

/** Base images for task environments: one per project and image key, built one at a time per project. */
export class Images {
  private cli?: Promise<string>;
  private readonly building = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  private readonly deps: ImagesDeps;
  constructor(deps: ImagesDeps) {
    this.deps = deps;
  }

  /** The image a worktree's config describes, built first when it doesn't exist yet — or always, without cache, with `noCache`. */
  async ensureBase(
    project: Project,
    worktree: EnvWorktree,
    keyFiles: string[],
    onLine: (line: string) => void,
    noCache = false
  ): Promise<{ key: string; ref: string }> {
    const [cliVersion, objects] = await Promise.all([
      this.cliVersion(),
      this.deps.objects(project, worktree, [...KEY_PATHS, ...keyFiles]),
    ]);
    const key = imageKey({ cliVersion, generation: 0, objects });
    const ref = baseImageRef(project.id, key);
    let pending = this.building.get(ref);
    if (!pending) {
      pending = this.enqueue(project.id, () =>
        this.buildIfMissing(ref, worktree.hostPath, project.id, onLine, noCache)
      ).finally(() => this.building.delete(ref));
      this.building.set(ref, pending);
    }
    await pending;
    return { key, ref };
  }

  private enqueue<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(projectId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(fn);
    this.queues.set(projectId, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(projectId) === next) {
          this.queues.delete(projectId);
        }
      });
    return next;
  }

  private async buildIfMissing(
    ref: string,
    folder: string,
    projectId: string,
    onLine: (line: string) => void,
    noCache: boolean
  ): Promise<void> {
    if (!noCache && (await this.deps.containers.imageExists(ref))) {
      return;
    }
    onLine(`image: building ${ref}${noCache ? " without cache" : ""}`);
    await this.deps.containers.build(
      folder,
      ref,
      onLine,
      [`${BASE_PROJECT_LABEL}=${projectId}`],
      noCache
    );
    onLine(`image: built ${ref}`);
  }

  private cliVersion(): Promise<string> {
    this.cli ??= this.deps
      .run("devcontainer", ["--version"], { timeoutMs: 15_000 })
      .then((r) => r.stdout.trim() || "unknown");
    return this.cli;
  }
}
