import type {
  EnvId,
  FormAnswer,
  ModelsInfo,
  PendingItems,
  PermissionDecision,
  ProjectId,
  SessionDetail,
  SessionSummary,
} from "../../shared/types";
import type { Environments } from "../environments/environments";
import type { HubDeps } from "../environments/ports";
import { AlreadyAnsweredError, NotFoundError } from "../errors";
import { InvalidRequestError } from "../git/worktrees";
import { isGone, isInvalidAnswer } from "../opencode/client";
import type { OpencodeClient } from "../opencode/client";
import { toModelsInfo } from "../tasks/request";
import {
  DETAIL_MESSAGES,
  subagentsOf,
  toBreakdown,
  toSessionTurns,
} from "./detail";

const MODELS_TTL_MS = 60_000;
const MODELS_RETRY_MS = 1500;
const DECISIONS: readonly string[] = [
  "once",
  "always",
  "reject",
] satisfies PermissionDecision[];

/** The project's opencode sessions: starting, prompting, inspecting and removing them, and answering what they ask. */
export class Sessions {
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  /** Models and agents per project for a minute; dropped when the environment stops being watched. */
  private readonly modelCache = new Map<
    ProjectId,
    { at: number; value: Promise<ModelsInfo> }
  >();
  constructor(deps: HubDeps, envs: Environments) {
    this.deps = deps;
    this.envs = envs;
    envs.onUnwatch((id) => this.modelCache.delete(id));
  }

  async startSession(
    id: ProjectId,
    directory: string,
    title?: string,
    prompt?: string
  ): Promise<string> {
    const project = this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    const env = this.envs.envForDirectory(project, directory);
    const client = this.envs.opencodeClient(env.id);
    const session = await client.createSession(directory, { title });
    if (prompt?.trim()) {
      await client.prompt(session.id, prompt, undefined, directory);
    }
    this.envs.reconcile(env.id);
    return session.id;
  }

  /**
   * Text generated in a checkout without adding to a session's history: in the given idle session of that
   * checkout, or in a new empty session titled `title` that stays around to follow up in.
   */
  async generateIn(
    id: ProjectId,
    directory: string,
    prompt: string,
    options: { sessionId?: string; title: string; timeoutMs?: number }
  ): Promise<{ sessionId: string; text: string }> {
    const project = this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    if (options.sessionId) {
      const session = this.deps.store
        .sessionsOf(id)
        .find((s) => s.id === options.sessionId);
      if (!session || session.directory !== directory) {
        throw new NotFoundError(options.sessionId, "session");
      }
      if (session.status !== "idle") {
        throw new InvalidRequestError("the session is still working");
      }
      const text = await this.envs
        .opencodeClient(session.envId ?? id)
        .generate(session.id, prompt, directory, options.timeoutMs);
      return { sessionId: session.id, text };
    }
    const env = this.envs.envForDirectory(project, directory);
    const client = this.envs.opencodeClient(env.id);
    const session = await client.createSession(directory, {
      title: options.title,
    });
    this.envs.reconcile(env.id);
    const text = await client.generate(
      session.id,
      prompt,
      directory,
      options.timeoutMs
    );
    return { sessionId: session.id, text };
  }

  /** Deletes one of the project's sessions with its subagents, stopping it first when it isn't idle. */
  async removeSession(id: ProjectId, sessionId: string): Promise<void> {
    this.envs.requireProject(id);
    const session = this.deps.store
      .sessionsOf(id)
      .find((s) => s.id === sessionId);
    if (!session) {
      throw new NotFoundError(sessionId, "session");
    }
    const envId = session.envId ?? id;
    const client = this.envs.opencodeClient(envId);
    if (session.status !== "idle") {
      await client.interrupt(sessionId, session.directory);
    }
    await client.deleteSession(sessionId, session.directory);
    this.envs.log(id, `removed session ${session.title}`);
    this.envs.reconcile(envId);
  }

  /** What one of the project's sessions did: its turns, token usage and subagents. */
  async sessionDetail(
    id: ProjectId,
    sessionId: string
  ): Promise<SessionDetail> {
    this.envs.requireProject(id);
    const session = this.deps.store
      .sessionsOf(id)
      .find((s) => s.id === sessionId);
    if (!session) {
      throw new NotFoundError(sessionId, "session");
    }
    const client = this.envs.opencodeClient(session.envId ?? id);
    const [raw, messages, all, models] = await Promise.all([
      client.session(sessionId),
      client.messages(sessionId, DETAIL_MESSAGES),
      client.sessions(),
      session.model
        ? client.models(session.directory).catch(() => [])
        : Promise.resolve([]),
    ]);
    const contextLimit = models.find(
      (m) =>
        m.id === session.model?.id && m.providerID === session.model.providerID
    )?.limit?.context;
    return {
      createdAt: raw.time.created,
      more: messages.length >= DETAIL_MESSAGES,
      session,
      subagents: subagentsOf(sessionId, all),
      turns: toSessionTurns(messages),
      ...(raw.agent ? { agent: raw.agent } : {}),
      ...(raw.outcome ? { outcome: raw.outcome } : {}),
      ...(raw.tokens ? { tokens: toBreakdown(raw.tokens) } : {}),
      ...(contextLimit ? { contextLimit } : {}),
    };
  }

  /** Sends a prompt to one of the project's sessions, queued behind the current turn when it is running. */
  async promptSession(
    id: ProjectId,
    sessionId: string,
    text: string
  ): Promise<void> {
    this.envs.requireProject(id);
    if (!text.trim()) {
      throw new InvalidRequestError("the prompt is empty");
    }
    const session = this.deps.store
      .sessionsOf(id)
      .find((s) => s.id === sessionId);
    if (!session) {
      throw new NotFoundError(sessionId, "session");
    }
    const envId = session.envId ?? id;
    await this.envs
      .opencodeClient(envId)
      .prompt(
        sessionId,
        text,
        session.status === "running" ? "queue" : undefined,
        session.directory
      );
    this.envs.reconcile(envId);
  }

  /** Models, the default model and the agents a new session can use; cached for a minute per project. */
  // oxlint-disable-next-line eslint/require-await -- async so that validation errors reject instead of throwing
  async models(id: ProjectId): Promise<ModelsInfo> {
    const project = this.envs.requireProject(id);
    const client = this.envs.opencodeClient(id);
    const now = (this.deps.now ?? Date.now)();
    const hit = this.modelCache.get(id);
    if (hit && now - hit.at < MODELS_TTL_MS) {
      return hit.value;
    }
    const ws = this.envs.workspaceFolder(project);
    const fetchOnce = () =>
      Promise.all([
        client.models(ws),
        client.defaultModel(ws).catch(() => undefined),
        client.agents(ws),
      ]).then(([models, def, agents]) => toModelsInfo(models, def, agents));
    const isEmpty = (v: ModelsInfo) =>
      v.models.length === 0 && v.agents.length === 0;
    const delay =
      this.deps.delay ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
    // A freshly started opencode answers these routes empty at first, so an empty answer gets one retry.
    const value = fetchOnce().then(async (first) => {
      if (!isEmpty(first)) {
        return first;
      }
      await delay(MODELS_RETRY_MS);
      return fetchOnce();
    });
    this.modelCache.set(id, { at: now, value });
    const forget = () => {
      if (this.modelCache.get(id)?.value === value) {
        this.modelCache.delete(id);
      }
    };
    // oxlint-disable-next-line promise/prefer-catch
    value.then((v) => isEmpty(v) && forget(), forget);
    return value;
  }

  /** Answers a permission request the dashboard listed for this project. */
  async replyPermission(
    id: ProjectId,
    requestId: string,
    reply: { decision: string; message?: string }
  ): Promise<void> {
    if (!DECISIONS.includes(reply.decision)) {
      throw new InvalidRequestError(`invalid decision "${reply.decision}"`);
    }
    const decision = reply.decision as PermissionDecision;
    await this.respond(
      id,
      "permission request",
      requestId,
      (p) => p.permissions.find((i) => i.id === requestId),
      (client, item, dir) =>
        client.replyPermission(
          item.sessionId,
          requestId,
          { decision, ...(reply.message ? { message: reply.message } : {}) },
          dir
        )
    );
  }

  /** Submits an answer to a form the dashboard listed for this project. */
  async replyForm(
    id: ProjectId,
    formId: string,
    answer: unknown
  ): Promise<void> {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      throw new InvalidRequestError("answer must be an object");
    }
    await this.respond(
      id,
      "form",
      formId,
      (p) => p.forms.find((i) => i.id === formId),
      (client, item, dir) =>
        client.replyForm(item.sessionId, formId, answer as FormAnswer, dir)
    );
  }

  /** Dismisses a form. */
  async cancelForm(id: ProjectId, formId: string): Promise<void> {
    await this.respond(
      id,
      "form",
      formId,
      (p) => p.forms.find((i) => i.id === formId),
      (client, item, dir) => client.cancelForm(item.sessionId, formId, dir)
    );
  }

  /**
   * Forwards a reply for a pending item, but only for ids in the latest snapshot: the dashboard never relays
   * ids it didn't list itself. Refreshes the snapshot afterwards, whatever happened.
   */
  private async respond<T extends { sessionId: string }>(
    id: ProjectId,
    what: string,
    itemId: string,
    find: (pending: PendingItems) => T | undefined,
    send: (client: OpencodeClient, item: T, directory: string) => Promise<void>
  ): Promise<void> {
    this.envs.requireProject(id);
    let found: { item: T; directory: string; envId: EnvId } | undefined;
    for (const s of this.deps.store.sessionsOf(id)) {
      const item = s.pending && find(s.pending);
      if (item) {
        found = { directory: s.directory, envId: s.envId ?? id, item };
        break;
      }
    }
    if (!found) {
      throw new NotFoundError(itemId, what);
    }
    const client = this.envs.opencodeClient(found.envId);
    try {
      await send(client, found.item, found.directory);
    } catch (error) {
      if (isGone(error)) {
        throw new AlreadyAnsweredError();
      }
      if (isInvalidAnswer(error)) {
        throw new InvalidRequestError(
          error.detail ?? "opencode rejected the answer"
        );
      }
      throw error;
    } finally {
      this.envs.reconcile(id);
      if (found.envId !== id) {
        this.envs.reconcile(found.envId);
      }
    }
  }

  latestSession(id: ProjectId, directory: string): SessionSummary | undefined {
    return this.deps.store
      .sessionsOf(id)
      .filter((s) => s.directory === directory)
      .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
  }
}
