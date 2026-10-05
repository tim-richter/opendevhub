import { createHash } from "node:crypto";
import type { EnvWorktree, Project } from "../shared/types";
import type { Containers } from "./containers";
import type { Runner } from "./exec";
import type { GitOps } from "./git";

/** What a config's image depends on, besides the key files a project lists. */
export const KEY_PATHS = [".devcontainer", ".devcontainer.json"];

export function imageKey(input: { cliVersion: string; objects: (string | undefined)[]; generation: number }): string {
  const parts = [input.cliVersion, input.objects.map((o) => o ?? null), input.generation];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function baseImageRef(projectId: string, key: string): string {
  return `opendevhub/${projectId}:${key.slice(0, 12)}-base`;
}

export interface ImagesDeps {
  run: Runner;
  containers: Pick<Containers, "imageExists" | "build">;
  git: Pick<GitOps, "headObjects">;
}

/** Base images for task environments: one per project and image key, built one at a time per project. */
export class Images {
  private cli?: Promise<string>;
  private readonly building = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: ImagesDeps) {}

  /** The image a worktree's config describes, built first when it doesn't exist yet. */
  async ensureBase(
    project: Project,
    worktree: EnvWorktree,
    keyFiles: string[],
    onLine: (line: string) => void,
  ): Promise<{ key: string; ref: string }> {
    const [cliVersion, objects] = await Promise.all([
      this.cliVersion(),
      this.deps.git.headObjects(project, worktree.path, [...KEY_PATHS, ...keyFiles]),
    ]);
    const key = imageKey({ cliVersion, objects, generation: 0 });
    const ref = baseImageRef(project.id, key);
    let pending = this.building.get(ref);
    if (!pending) {
      pending = this.enqueue(project.id, () => this.buildIfMissing(ref, worktree.hostPath, onLine)).finally(() =>
        this.building.delete(ref),
      );
      this.building.set(ref, pending);
    }
    await pending;
    return { key, ref };
  }

  private enqueue<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(projectId) ?? Promise.resolve()).catch(() => {}).then(fn);
    this.queues.set(projectId, next);
    void next.catch(() => {}).finally(() => {
      if (this.queues.get(projectId) === next) this.queues.delete(projectId);
    });
    return next;
  }

  private async buildIfMissing(ref: string, folder: string, onLine: (line: string) => void): Promise<void> {
    if (await this.deps.containers.imageExists(ref)) return;
    onLine(`image: building ${ref}`);
    await this.deps.containers.build(folder, ref, onLine);
    onLine(`image: built ${ref}`);
  }

  private cliVersion(): Promise<string> {
    this.cli ??= this.deps.run("devcontainer", ["--version"], { timeoutMs: 15_000 }).then((r) => r.stdout.trim() || "unknown");
    return this.cli;
  }
}
