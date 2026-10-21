import type {
  EnvId,
  ProjectId,
  SavedPermission,
  SavedPermissionsView,
} from "../../shared/types";
import type { Environments } from "../environments/environments";
import type { HubDeps } from "../environments/ports";
import { ConflictError, NotFoundError, UnavailableError } from "../errors";
import { isGone } from "../opencode/client";
import type { OpencodeClient, RawSavedPermission } from "../opencode/client";
import { atLeast } from "../opencode/runtime";

/** The first opencode that can change a saved rule (`PATCH /api/permission/saved/:id`). */
export const EDIT_SINCE = "2.1.0";

export const STOPPED_MESSAGE =
  "Start the container to see its saved permissions.";

const toRule = (r: RawSavedPermission): SavedPermission => ({
  action: r.action,
  createdAt: r.time.created,
  id: r.id,
  resource: r.resource,
  updatedAt: r.time.updated,
});

/**
 * The rules opencode saved from "always" answers, per environment: listed from opencode each time, filtered to the
 * opencode project of the environment's checkouts. Removing works on any opencode v2; editing needs 2.1.
 */
export class SavedPermissions {
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  constructor(deps: HubDeps, envs: Environments) {
    this.deps = deps;
    this.envs = envs;
  }

  async list(id: ProjectId, envId: EnvId): Promise<SavedPermissionsView> {
    this.requireEnv(id, envId);
    const canEdit = this.canEdit(envId);
    if (this.deps.store.runtime(envId).containerState !== "running") {
      return { canEdit, rules: [], unavailable: STOPPED_MESSAGE };
    }
    const rules = await this.rulesOf(
      id,
      envId,
      this.envs.opencodeClient(envId)
    );
    return { canEdit, rules: rules.map(toRule) };
  }

  async update(
    id: ProjectId,
    envId: EnvId,
    ruleId: string,
    patch: { action?: string; resource?: string }
  ): Promise<SavedPermission> {
    this.requireEnv(id, envId);
    const client = this.runningClient(envId);
    if (!this.canEdit(envId)) {
      throw new ConflictError(
        `editing saved permissions needs opencode ${EDIT_SINCE} or later`
      );
    }
    const rule = await this.findRule(id, envId, client, ruleId);
    if (!rule) {
      throw new NotFoundError(ruleId, "saved permission");
    }
    let updated: RawSavedPermission;
    try {
      updated = await client.updateSavedPermission(ruleId, patch);
    } catch (error) {
      throw isGone(error)
        ? new NotFoundError(ruleId, "saved permission")
        : error;
    }
    this.envs.log(
      id,
      `permissions: changed saved rule ${rule.action} ${rule.resource} to ${updated.action} ${updated.resource}`,
      envId
    );
    return toRule(updated);
  }

  /** Removes a rule; one that is gone already, or isn't this environment's, counts as removed. */
  async remove(id: ProjectId, envId: EnvId, ruleId: string): Promise<void> {
    this.requireEnv(id, envId);
    const client = this.runningClient(envId);
    const rule = await this.findRule(id, envId, client, ruleId);
    if (!rule) {
      return;
    }
    try {
      await client.deleteSavedPermission(ruleId);
    } catch (error) {
      if (!isGone(error)) {
        throw error;
      }
    }
    this.envs.log(
      id,
      `permissions: removed saved rule ${rule.action} ${rule.resource}`,
      envId
    );
  }

  private canEdit(envId: EnvId): boolean {
    return atLeast(this.deps.store.runtime(envId).opencodeVersion, EDIT_SINCE);
  }

  private requireEnv(id: ProjectId, envId: EnvId): void {
    this.envs.requireProject(id);
    if (envId !== id && this.deps.store.environment(envId)?.projectId !== id) {
      throw new NotFoundError(envId, "environment");
    }
  }

  private runningClient(envId: EnvId): OpencodeClient {
    if (this.deps.store.runtime(envId).containerState !== "running") {
      throw new UnavailableError(STOPPED_MESSAGE);
    }
    return this.envs.opencodeClient(envId);
  }

  /**
   * The rules of the environment's opencode project: the `projectID` of its sessions in its checkouts (worktrees
   * share the repository's). Before any session, every project opencode knows, which per environment is rarely
   * more than one.
   */
  private async rulesOf(
    id: ProjectId,
    envId: EnvId,
    client: OpencodeClient
  ): Promise<RawSavedPermission[]> {
    const dirs = this.directories(id, envId);
    const sessions = await client.sessions();
    const owned = new Set(
      sessions.flatMap((s) =>
        s.projectID && dirs.has(s.location.directory) ? [s.projectID] : []
      )
    );
    const known = owned.size > 0 ? [] : await client.projects();
    const projects = owned.size > 0 ? owned : new Set(known.map((p) => p.id));
    const rules = await client.savedPermissions();
    return rules.filter((r) => projects.has(r.projectID));
  }

  private async findRule(
    id: ProjectId,
    envId: EnvId,
    client: OpencodeClient,
    ruleId: string
  ): Promise<RawSavedPermission | undefined> {
    const rules = await this.rulesOf(id, envId, client);
    return rules.find((r) => r.id === ruleId);
  }

  /** The checkouts whose sessions an environment's opencode runs: its worktree, or the workspace and every worktree. */
  private directories(id: ProjectId, envId: EnvId): Set<string> {
    const { store } = this.deps;
    const own = store.environment(envId)?.worktree.path;
    if (envId !== id && own) {
      return new Set([own]);
    }
    return new Set([
      this.envs.workspaceFolder(this.envs.requireProject(id)),
      ...(store.runtime(id).worktrees ?? []).map((w) => w.path),
    ]);
  }
}
