import { CheckoutStore } from "../../src/server/db/checkouts";
import { openDatabase } from "../../src/server/db/database";
import { EnvironmentStore } from "../../src/server/db/environments";
import type { DurableRuntime } from "../../src/server/db/environments";
import { SYSTEM } from "../../src/server/db/events";
import { LinkStore } from "../../src/server/db/links";
import { ProjectStore } from "../../src/server/db/projects";
import { TaskStore } from "../../src/server/db/tasks";
import type {
  EnvId,
  EnvWorktree,
  NodeId,
  ProjectId,
} from "../../src/shared/types";

/** A fresh in-memory database with its stores. */
export const memoryStores = (now?: () => number) => {
  const db = openDatabase(":memory:");
  return {
    checkouts: new CheckoutStore(db, now),
    db,
    environments: new EnvironmentStore(db, now),
    links: new LinkStore(db, now),
    projects: new ProjectStore(db, now),
    tasks: new TaskStore(db, now),
  };
};

/** What a `StateStore` reads from the database, from one in-memory database. */
export const stateStores = (dbs = memoryStores()) => ({
  environments: dbs.environments,
  links: dbs.links,
  tasks: dbs.tasks,
});

type Stores = ReturnType<typeof memoryStores>;

/** The id of the project's live worktree row at `wt.path`, recorded as unmanaged when it has none. */
export const worktreeRow = (
  dbs: Pick<Stores, "checkouts">,
  projectId: ProjectId,
  wt: EnvWorktree,
  node?: NodeId
): number =>
  dbs.checkouts
    .worktreesOf(projectId)
    .find((w) => w.path === wt.path && w.node === node)?.id ??
  dbs.checkouts.recordCreated(
    projectId,
    { ...wt, ...(node ? { node } : {}) },
    { by: "unmanaged" },
    SYSTEM
  ).worktree.id;

/** What a restart finds in the database: main environments' runtimes and task environments. Projects must exist. */
export interface Seed {
  projects?: Record<ProjectId, DurableRuntime>;
  environments?: Record<
    EnvId,
    DurableRuntime & {
      projectId: ProjectId;
      worktree: EnvWorktree;
      node?: NodeId;
      image?: { key: string; ref: string };
    }
  >;
}

export const seed = (dbs: Stores, data: Seed): void => {
  for (const [id, runtime] of Object.entries(data.projects ?? {})) {
    dbs.environments.updateDurable(id, runtime);
  }
  for (const [id, env] of Object.entries(data.environments ?? {})) {
    const { projectId, worktree, node, image, ...runtime } = env;
    dbs.environments.putTask(
      {
        id,
        projectId,
        worktreeId: worktreeRow(dbs, projectId, worktree, node),
        ...(node ? { node } : {}),
      },
      SYSTEM
    );
    dbs.environments.updateDurable(id, {
      ...runtime,
      ...(image ? { image } : {}),
    });
  }
};

/** Records task environment `id` on a worktree of its own, for tests that only need the row to exist. */
export const taskEnvironment = (
  dbs: Stores,
  projectId: ProjectId,
  id: EnvId,
  worktreePath = `/w/${id}`
): void =>
  seed(dbs, {
    environments: {
      [id]: {
        projectId,
        worktree: { branch: id, hostPath: worktreePath, path: worktreePath },
      },
    },
  });
