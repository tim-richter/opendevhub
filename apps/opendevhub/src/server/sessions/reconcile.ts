import type { EnvId, ProjectId } from "../../shared/types";
import type { TaskStore } from "../db/tasks";
import type { RawSession } from "../opencode/client";

/** What opencode says about a session it didn't list: still there, gone (deleted or archived), or no answer. */
export type Presence = "alive" | "gone" | "unknown";

/** Sessions looked up one by one per pass, at most. */
const MAX_LOOKUPS = 20;

export interface ReconcileInput {
  projectId: ProjectId;
  envId: EnvId;
  /** One successful listing of the environment's sessions, subagents and archived ones included. */
  sessions: RawSession[];
  /** The branch checked out in a directory, when it is a worktree. */
  branchOf: (directory: string) => string | undefined;
  /** Asks opencode about one session; the listing holds only the newest ones. */
  lookup: (sessionId: string) => Promise<Presence>;
}

/**
 * Brings the tasks in line with an environment's sessions after a successful listing: adopts top-level sessions
 * without a task as manual tasks (except in directories where opendevhub is creating a session), lets manual tasks'
 * titles follow their sessions, and marks variants' sessions removed or back. Adoption and titles happen before
 * the first await, so the sessions the listing reports already have their tasks.
 */
export const reconcileTasks = async (
  tasks: Pick<
    TaskStore,
    | "sessionRef"
    | "isClaimed"
    | "adoptSession"
    | "setManualTitle"
    | "liveSessionsIn"
    | "markSessionsGone"
  >,
  input: ReconcileInput
): Promise<void> => {
  const { envId, projectId } = input;
  const listed = input.sessions.filter(
    (s) => !s.parentID && s.time.archived === undefined
  );
  for (const s of listed) {
    const title = s.title?.trim() || "Untitled session";
    const ref = tasks.sessionRef(s.id);
    if (ref) {
      if (ref.kind === "manual") {
        tasks.setManualTitle(s.id, title);
      }
      continue;
    }
    const { directory } = s.location;
    if (tasks.isClaimed(envId, directory)) {
      // Its creator is about to attach it; a later pass adopts it if that never happens.
      continue;
    }
    tasks.adoptSession({
      branch: input.branchOf(directory),
      createdAt: s.time.created,
      directory,
      envId,
      projectId,
      sessionId: s.id,
      title,
    });
  }
  const present = new Set(listed.map((s) => s.id));
  const archived = new Set(
    input.sessions.filter((s) => s.time.archived !== undefined).map((s) => s.id)
  );
  const unlisted = tasks
    .liveSessionsIn(envId)
    .filter((id) => !present.has(id) && !archived.has(id));
  if (unlisted.length > 0) {
    const answers = await Promise.all(
      unlisted.map((id, i) =>
        i < MAX_LOOKUPS ? input.lookup(id) : Promise.resolve("unknown" as const)
      )
    );
    for (const [i, id] of unlisted.entries()) {
      if (answers[i] !== "gone") {
        present.add(id);
      }
    }
  }
  tasks.markSessionsGone(envId, present);
};
