import type { Project, ProjectId } from "../../shared/types";
import { transaction } from "./database";
import type { Db } from "./database";
import { insertMainIn } from "./environments";
import { SYSTEM, record } from "./events";

export interface ProjectRow extends Project {
  firstSeenAt: number;
  missingSince?: number;
}

interface RawProject {
  id: string;
  path: string;
  name: string;
  devcontainer_path: string;
  first_seen_at: number;
  missing_since: number | null;
}

const toProject = (r: RawProject): ProjectRow => ({
  devcontainerPath: r.devcontainer_path,
  firstSeenAt: r.first_seen_at,
  id: r.id,
  name: r.name,
  path: r.path,
  ...(r.missing_since === null ? {} : { missingSince: r.missing_since }),
});

/**
 * The projects discovery has found, each with its main environment. Rows are never deleted, so a project's tasks
 * survive it going missing.
 */
export class ProjectStore {
  private readonly db: Db;
  private readonly now: () => number;
  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /**
   * Records what discovery found: new projects are inserted, known ones updated and no longer missing, and the
   * rows not in `list` marked missing. Only changes write events.
   */
  upsertAll(list: Project[]): void {
    const at = this.now();
    transaction(this.db, () => {
      const known = new Map(
        (
          this.db
            .prepare("SELECT * FROM projects")
            .all() as unknown as RawProject[]
        ).map((r) => [r.id, toProject(r)])
      );
      for (const p of list) {
        const row = known.get(p.id);
        if (!row) {
          this.db
            .prepare(
              "INSERT INTO projects (id, path, name, devcontainer_path, first_seen_at) VALUES (?, ?, ?, ?, ?)"
            )
            .run(p.id, p.path, p.name, p.devcontainerPath, at);
          record(this.db, {
            actor: SYSTEM,
            at,
            data: { name: p.name, path: p.path },
            object: { id: p.id, type: "project" },
            projectId: p.id,
            verb: "project.discovered",
          });
          insertMainIn(this.db, p.id, at);
          continue;
        }
        const returned = row.missingSince !== undefined;
        if (
          !returned &&
          row.name === p.name &&
          row.path === p.path &&
          row.devcontainerPath === p.devcontainerPath
        ) {
          continue;
        }
        this.db
          .prepare(
            "UPDATE projects SET path = ?, name = ?, devcontainer_path = ?, missing_since = NULL WHERE id = ?"
          )
          .run(p.path, p.name, p.devcontainerPath, p.id);
        if (returned) {
          record(this.db, {
            actor: SYSTEM,
            at,
            data: { name: p.name, path: p.path, returned: true },
            object: { id: p.id, type: "project" },
            projectId: p.id,
            verb: "project.discovered",
          });
        }
      }
      const found = new Set(list.map((p) => p.id));
      for (const row of known.values()) {
        if (found.has(row.id) || row.missingSince !== undefined) {
          continue;
        }
        this.db
          .prepare("UPDATE projects SET missing_since = ? WHERE id = ?")
          .run(at, row.id);
        record(this.db, {
          actor: SYSTEM,
          at,
          data: { name: row.name, path: row.path },
          object: { id: row.id, type: "project" },
          projectId: row.id,
          verb: "project.missing",
        });
      }
    });
  }

  get(id: ProjectId): ProjectRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(id) as RawProject | undefined;
    return row ? toProject(row) : undefined;
  }
}
