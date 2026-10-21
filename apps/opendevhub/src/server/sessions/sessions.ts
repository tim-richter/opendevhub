import { HUB_COMMANDS } from "../../shared/types";
import type {
  AgentOption,
  ComposerCommand,
  ComposerSendRequest,
  ComposerSendResult,
  EnvId,
  FormAnswer,
  ModelRef,
  ModelsInfo,
  PendingItems,
  PermissionDecision,
  Project,
  ProjectId,
  SessionDetail,
  SessionSummary,
  SpecWorkflow,
  VariantView,
} from "../../shared/types";
import { USER } from "../db/events";
import type { TaskRecord } from "../db/tasks";
import type { Environments } from "../environments/environments";
import type { HubDeps } from "../environments/ports";
import { AlreadyAnsweredError, NotFoundError } from "../errors";
import { InvalidRequestError } from "../git/worktrees";
import { OpencodeHttpError, isGone, isInvalidAnswer } from "../opencode/client";
import type {
  OpencodeClient,
  PromptAttachments,
  RawCommand,
  RawSession,
} from "../opencode/client";
import { BRIEFING_KEY, buildBriefing, gatherBriefing } from "../tasks/briefing";
import { OPENSPEC_CLI_CHECK, specWorkflow } from "../tasks/openspec";
import { toModelsInfo } from "../tasks/request";
import {
  DETAIL_MESSAGES,
  subagentsOf,
  toBreakdown,
  toSessionTurns,
  toTranscript,
  withBriefing,
} from "./detail";
import {
  attachmentsOf,
  hubCommandOf,
  resolveMessage,
  slashOf,
} from "./message";

const MODELS_TTL_MS = 60_000;
const MODELS_RETRY_MS = 1500;
/** At most this many `@` file suggestions per query. */
export const FILE_SEARCH_LIMIT = 50;
const DECISIONS: readonly string[] = [
  "once",
  "always",
  "reject",
] satisfies PermissionDecision[];

/** The project's opencode sessions: starting, prompting, inspecting and removing them, and answering what they ask. */
/** Whether `b` is model `a`; opencode reports its default variant as "default" or not at all. */
const sameModel = (a: ModelRef, b: ModelRef | undefined): boolean =>
  b !== undefined &&
  a.id === b.id &&
  a.providerID === b.providerID &&
  (a.variant ?? "default") === (b.variant ?? "default");

export class Sessions {
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  /** Models and agents per project for a minute; dropped when the environment stops being watched. */
  private readonly modelCache = new Map<
    ProjectId,
    { at: number; value: Promise<ModelsInfo> }
  >();
  /** A checkout's commands and agents, per project and directory, kept like `modelCache`. */
  private readonly commandCache = new Map<
    ProjectId,
    Map<string, { at: number; value: Promise<RawCommand[]> }>
  >();
  private readonly agentCache = new Map<
    ProjectId,
    Map<string, { at: number; value: Promise<AgentOption[]> }>
  >();
  constructor(deps: HubDeps, envs: Environments) {
    this.deps = deps;
    this.envs = envs;
    envs.onUnwatch((id) => {
      this.modelCache.delete(id);
      this.commandCache.delete(id);
      this.agentCache.delete(id);
    });
  }

  async startSession(
    id: ProjectId,
    directory: string,
    title?: string,
    prompt?: string,
    options: {
      reviewOf?: number;
      attachments?: PromptAttachments;
      model?: ModelRef;
      agent?: string;
    } = {}
  ): Promise<{ sessionId: string; chat?: string }> {
    const project = this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    const env = this.envs.envForDirectory(project, directory);
    const client = this.envs.opencodeClient(env.id);
    const { session, chat } = await this.createOutsideTask(
      project,
      env.id,
      client,
      directory,
      title,
      { agent: options.agent, model: options.model, reviewOf: options.reviewOf }
    );
    if (prompt?.trim()) {
      await client.prompt(
        session.id,
        prompt,
        undefined,
        directory,
        options.attachments ?? {}
      );
    }
    this.envs.reconcile(env.id);
    return { sessionId: session.id, ...(chat ? { chat } : {}) };
  }

  /**
   * Starts a conversation in a checkout with `prompt` as its first turn: a new conversation of the task variant
   * `taskSession` belongs to when that variant works in the checkout, else a chat.
   */
  async startInCheckout(
    id: ProjectId,
    directory: string,
    title: string,
    prompt: string,
    taskSession?: string
  ): Promise<{ sessionId: string; chat?: string }> {
    const owner = taskSession && this.deps.tasks.bySession(taskSession);
    if (
      owner &&
      owner.task.projectId === id &&
      !owner.variant.discarded &&
      owner.variant.directory === directory
    ) {
      const sessionId = await this.startTaskConversation(id, taskSession, {
        prompt,
        title,
      });
      return { sessionId };
    }
    return this.startSession(id, directory, title, prompt);
  }

  /**
   * Starts a chat in a checkout with a composer message as its first turn: a
   * command the checkout has, or a prompt. The message is resolved first, so that a bad mention starts nothing.
   * Hub commands are the caller's to refuse.
   */
  async startWithMessage(
    id: ProjectId,
    directory: string,
    request: ComposerSendRequest
  ): Promise<{ sessionId: string; chat: string }> {
    const project = this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    const env = this.envs.envForDirectory(project, directory);
    const client = this.envs.opencodeClient(env.id);
    const message = await resolveMessage(
      () => this.checkoutCommands(id, directory),
      directory,
      request
    );
    const { session, chat } = await this.createOutsideTask(
      project,
      env.id,
      client,
      directory,
      undefined,
      { agent: request.agent, model: request.model }
    );
    await (message.command
      ? client.command(
          session.id,
          message.command,
          message.text,
          directory,
          message.attachments
        )
      : client.prompt(
          session.id,
          message.text,
          undefined,
          directory,
          message.attachments
        ));
    this.envs.reconcile(env.id);
    if (!chat) {
      throw new Error(`the conversation ${session.id} has no chat`);
    }
    return { chat, sessionId: session.id };
  }

  /**
   * Text generated in a checkout without adding to a session's history: in the given idle session of that
   * checkout, or in a new empty session titled `title` that stays around to follow up in. The new session is an
   * internal chat, never listed; with `reviewOf` (a pull request row), it gets a review task instead.
   */
  async generateIn(
    id: ProjectId,
    directory: string,
    prompt: string,
    options: {
      sessionId?: string;
      title: string;
      timeoutMs?: number;
      reviewOf?: number;
    }
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
    const { session } = await this.createOutsideTask(
      project,
      env.id,
      client,
      directory,
      options.title,
      { internal: true, reviewOf: options.reviewOf }
    );
    this.envs.reconcile(env.id);
    const text = await client.generate(
      session.id,
      prompt,
      directory,
      options.timeoutMs
    );
    return { sessionId: session.id, text };
  }

  /**
   * Creates a session outside a task and records its owner before anything reconciles the environment: a chat
   * (`internal` when it only generates text), or a review task with `reviewOf`. The directory is claimed
   * meanwhile, so that reconcile doesn't adopt the session first.
   */
  private async createOutsideTask(
    project: Project,
    envId: EnvId,
    client: OpencodeClient,
    directory: string,
    title: string | undefined,
    options: {
      reviewOf?: number;
      model?: ModelRef;
      agent?: string;
      internal?: boolean;
    } = {}
  ): Promise<{ session: RawSession; chat?: string }> {
    const { reviewOf, model, agent, internal } = options;
    const { tasks, chats } = this.deps;
    const release = tasks.claim(envId, directory);
    try {
      const session = await client.createSession(directory, {
        title,
        ...(model ? { model } : {}),
        ...(agent ? { agent } : {}),
      });
      const createdAt =
        (session.time as RawSession["time"] | undefined)?.created ??
        (this.deps.now ?? Date.now)();
      const named =
        session.title?.trim() || title?.trim() || "Untitled session";
      const where = this.checkoutOf(project, envId, directory);
      if (reviewOf !== undefined) {
        tasks.startReview({
          createdAt,
          directory,
          envId,
          projectId: project.id,
          reviewOf,
          sessionId: session.id,
          title: named,
          ...(where.branch ? { branch: where.branch } : {}),
        });
        return { session };
      }
      const chat = chats.insert({
        createdAt,
        directory,
        envId,
        origin: internal ? "internal" : "hub",
        projectId: project.id,
        sessionId: session.id,
        step: "session",
        title: named,
        ...where,
      });
      return { chat: chat.id, session };
    } finally {
      release();
    }
  }

  /** The branch, branch row and worktree row of one of the project's checkouts; none for the main checkout. */
  private checkoutOf(
    project: Project,
    envId: EnvId,
    directory: string
  ): { branch?: string; branchId?: number; worktreeId?: number } {
    if (directory === this.envs.workspaceFolder(project)) {
      return {};
    }
    const { store, checkouts } = this.deps;
    const env = store.environment(envId);
    const branch =
      env?.worktree.branch ??
      store.runtime(project.id).worktrees?.find((w) => w.path === directory)
        ?.branch;
    const row = checkouts
      .worktreesOf(project.id)
      .find((w) => w.path === directory && w.node === env?.node);
    return {
      ...(branch ? { branch } : {}),
      ...(row ? { worktreeId: row.id } : {}),
      ...(row?.branchId === undefined ? {} : { branchId: row.branchId }),
    };
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

  /** Kills a shell command one of the project's sessions left running in the background. */
  async killShell(
    id: ProjectId,
    sessionId: string,
    shellId: string
  ): Promise<void> {
    this.envs.requireProject(id);
    const session = this.deps.store
      .sessionsOf(id)
      .find((s) => s.id === sessionId);
    const shell = session?.shells?.find((s) => s.id === shellId);
    if (!session || !shell) {
      throw new NotFoundError(shellId, "shell");
    }
    const envId = session.envId ?? id;
    await this.envs.opencodeClient(envId).killShell(shellId, shell.directory);
    this.envs.log(id, `killed background command ${shell.command}`);
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
    const briefed = this.deps.tasks.bySession(sessionId) !== undefined;
    const [raw, messages, all, children, models, instructions] =
      await Promise.all([
        client.session(sessionId),
        client.messages(sessionId, DETAIL_MESSAGES),
        client.sessions(),
        client.childSessions(sessionId),
        client.models(session.directory).catch(() => []),
        briefed
          ? client.instructions(sessionId, session.directory).catch(() => [])
          : [],
      ]);
    const model =
      messages.find((message) => message.type === "assistant" && message.model)
        ?.model ??
      raw.model ??
      session.model;
    const contextLimit = models.find(
      (candidate) =>
        candidate.id === model?.id && candidate.providerID === model.providerID
    )?.limit?.context;
    return {
      createdAt: raw.time.created,
      more: messages.length >= DETAIL_MESSAGES,
      session,
      subagents: subagentsOf(sessionId, [
        ...new Map(
          [...all, ...children].map((entry) => [entry.id, entry])
        ).values(),
      ]),
      transcript: withBriefing(
        toTranscript(messages),
        instructions,
        raw.time.created
      ),
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

  /**
   * Sends what the composer holds: `/new` and `/interrupt` are the hub's; `/name` of a command the checkout has
   * runs it with the rest as arguments; anything else, unknown `/name` included, is a prompt. Mentions go along as
   * opencode's attachments either way. A running conversation gets it queued behind the current turn.
   */
  async sendMessage(
    id: ProjectId,
    sessionId: string,
    request: ComposerSendRequest
  ): Promise<ComposerSendResult> {
    this.envs.requireProject(id);
    const { text } = request;
    if (!text.trim()) {
      throw new InvalidRequestError("the message is empty");
    }
    const session = this.deps.store
      .sessionsOf(id)
      .find((s) => s.id === sessionId);
    if (!session) {
      throw new NotFoundError(sessionId, "session");
    }
    const { directory } = session;
    const envId = session.envId ?? id;
    const client = this.envs.opencodeClient(envId);
    const queued = session.status === "running";
    const delivery = queued ? ("queue" as const) : undefined;
    const hub = hubCommandOf(text);

    if (hub === "interrupt") {
      if (session.status === "idle") {
        throw new InvalidRequestError("the conversation isn't working");
      }
      await client.interrupt(sessionId, directory);
      this.envs.reconcile(envId);
      return { kind: "interrupt" };
    }
    if (hub === "new") {
      const { offset } = slashOf(text);
      const owner = this.deps.tasks.bySession(sessionId);
      if (owner) {
        const fresh = await this.startTaskConversation(id, sessionId, request);
        const prompt = text.slice(offset).trim();
        if (prompt) {
          await client.prompt(
            fresh,
            prompt,
            undefined,
            directory,
            attachmentsOf(directory, request, offset)
          );
          this.envs.reconcile(envId);
        }
        return { kind: "new", sessionId: fresh };
      }
      const started = await this.startSession(
        id,
        directory,
        undefined,
        text.slice(offset).trim() || undefined,
        {
          agent: request.agent,
          attachments: attachmentsOf(directory, request, offset),
          model: request.model,
        }
      );
      return {
        kind: "new",
        sessionId: started.sessionId,
        ...(started.chat ? { chat: started.chat } : {}),
      };
    }
    if (request.model && !sameModel(request.model, session.model)) {
      await client.switchModel(sessionId, request.model, directory);
    }
    if (request.agent) {
      await client.switchAgent(sessionId, request.agent, directory);
    }
    const message = await resolveMessage(
      () => this.checkoutCommands(id, directory),
      directory,
      request
    );
    if (message.command) {
      await client.command(
        sessionId,
        message.command,
        message.text,
        directory,
        {
          ...message.attachments,
          ...(delivery ? { delivery } : {}),
        }
      );
      this.envs.reconcile(envId);
      return { kind: "command", name: message.command, queued };
    }
    await client.prompt(
      sessionId,
      message.text,
      delivery,
      directory,
      message.attachments
    );
    this.envs.reconcile(envId);
    return { kind: "prompt", queued };
  }

  /** The `/` suggestions for a checkout: the hub's commands, then opencode's, marked when a hub command hides one. */
  async composerCommands(
    id: ProjectId,
    directory: string
  ): Promise<ComposerCommand[]> {
    const own = await this.checkoutCommands(id, directory);
    const hub = new Set<string>(HUB_COMMANDS.map((c) => c.name));
    return [
      ...HUB_COMMANDS.map((c) => ({ ...c, hub: true })),
      ...own.map((c) => ({
        name: c.name,
        ...(c.description ? { description: c.description } : {}),
        ...(hub.has(c.name) ? { shadowed: true } : {}),
      })),
    ];
  }

  /** The agents `@` can mention in a checkout: visible subagents, as opencode's own prompt offers them. */
  // oxlint-disable-next-line eslint/require-await -- async so that validation errors reject instead of throwing
  async composerAgents(
    id: ProjectId,
    directory: string
  ): Promise<AgentOption[]> {
    const client = this.checkoutClient(id, directory);
    return this.cached(this.agentCache, id, directory, async () => {
      const agents = await client.agents(directory);
      return agents
        .filter((a) => !a.hidden && a.mode !== "primary")
        .map((a) => ({
          id: a.id,
          name: a.name,
          ...(a.description ? { description: a.description } : {}),
        }));
    });
  }

  /** Files in a checkout matching `query`, at most `FILE_SEARCH_LIMIT`; none when opencode has no file search. */
  async findFiles(
    id: ProjectId,
    directory: string,
    query: string
  ): Promise<string[]> {
    const client = this.checkoutClient(id, directory);
    try {
      return await client.findFiles(directory, query, FILE_SEARCH_LIMIT);
    } catch (error) {
      if (error instanceof OpencodeHttpError && error.status === 404) {
        return [];
      }
      throw error;
    }
  }

  // oxlint-disable-next-line eslint/require-await -- async so that validation errors reject instead of throwing
  private async checkoutCommands(
    id: ProjectId,
    directory: string
  ): Promise<RawCommand[]> {
    const client = this.checkoutClient(id, directory);
    return this.cached(this.commandCache, id, directory, () =>
      client.commands(directory)
    );
  }

  /** The opencode serving one of the project's checkouts; refuses any other directory. */
  private checkoutClient(id: ProjectId, directory: string): OpencodeClient {
    const project = this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    return this.envs.opencodeClient(
      this.envs.envForDirectory(project, directory).id
    );
  }

  /** `fetch`'s answer for a minute per project and directory; a failed one is forgotten at once. */
  private cached<T>(
    cache: Map<ProjectId, Map<string, { at: number; value: Promise<T> }>>,
    id: ProjectId,
    directory: string,
    fetch: () => Promise<T>
  ): Promise<T> {
    const now = (this.deps.now ?? Date.now)();
    const entries = cache.get(id) ?? new Map();
    cache.set(id, entries);
    const hit = entries.get(directory);
    if (hit && now - hit.at < MODELS_TTL_MS) {
      return hit.value;
    }
    const value = fetch();
    entries.set(directory, { at: now, value });
    value.catch(() => {
      if (entries.get(directory)?.value === value) {
        entries.delete(directory);
      }
    });
    return value;
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
        this.specWorkflow(project, client, ws),
      ]).then(([models, def, agents, spec]) => ({
        ...toModelsInfo(models, def, agents),
        ...(spec ? { spec } : {}),
      }));
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

  /** OpenSpec's workflow in the project's environment; an opencode that can't list commands has none. */
  private async specWorkflow(
    project: Project,
    client: OpencodeClient,
    ws: string
  ): Promise<SpecWorkflow | undefined> {
    const workflow = specWorkflow(await client.commands(ws).catch(() => []));
    if (!workflow) {
      return undefined;
    }
    // 1 is the check's own "not found"; anything else means the container couldn't be asked.
    const cli = await this.deps.containers
      .exec?.(project, ["sh", "-c", OPENSPEC_CLI_CHECK])
      .then(
        (r) =>
          r.exitCode === 0 || r.exitCode === 1 ? r.exitCode === 0 : undefined,
        () => undefined
      );
    return { ...workflow, ...(cli === undefined ? {} : { cli }) };
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

  /** Starts with empty context while preserving ownership and the checkout; `prompt` becomes its first turn. */
  async startTaskConversation(
    id: ProjectId,
    sessionId: string,
    options: {
      model?: ModelRef;
      agent?: string;
      title?: string;
      prompt?: string;
    } = {}
  ): Promise<string> {
    this.envs.requireProject(id);
    const found = this.deps.tasks.bySession(sessionId);
    if (!found || found.task.projectId !== id || found.variant.discarded) {
      throw new NotFoundError(sessionId, "task conversation");
    }
    const { task, variant } = found;
    const { directory } = variant;
    if (!directory) {
      throw new InvalidRequestError("the task has no checkout");
    }
    this.envs.checkDirectory(id, directory);
    const envId = variant.envId ?? id;
    const client = this.envs.opencodeClient(envId);
    const release = this.deps.tasks.claim(envId, directory);
    let session: RawSession;
    try {
      session = await client.createSession(directory, {
        title: options.title ?? task.title,
        model:
          options.model ??
          this.deps.store.sessionsOf(id).find((s) => s.id === sessionId)
            ?.model ??
          variant.model,
        agent: options.agent ?? variant.agent,
      });
      this.deps.tasks.attachSession(
        task.id,
        variant.n,
        { sessionId: session.id, envId, directory },
        USER
      );
    } finally {
      release();
    }
    await this.brief(client, task, { ...variant, directory }, session.id);
    if (options.prompt?.trim()) {
      await client.prompt(session.id, options.prompt, undefined, directory, {});
    }
    this.envs.reconcile(envId);
    return session.id;
  }

  /**
   * Gives a new conversation of a task variant its task briefing, as an instruction entry. A briefing that can't be
   * built or attached, as with an opencode without the instructions route, is logged and the conversation goes on.
   */
  private async brief(
    client: OpencodeClient,
    task: TaskRecord,
    variant: VariantView & { directory: string },
    sessionId: string
  ): Promise<void> {
    const warn = (what: string, error: unknown) =>
      console.warn(
        `task briefing for task ${task.id}, session ${sessionId}: ${what}: ${error instanceof Error ? error.message : String(error)}`
      );
    try {
      const project = this.envs.requireProject(task.projectId);
      const remote = this.envs.remoteEnvAt(project, variant.directory);
      const titles = new Map(
        this.deps.store.sessionsOf(task.projectId).map((s) => [s.id, s.title])
      );
      const earlier = this.deps.tasks
        .variantSessions(task.id, variant.n)
        .filter((id) => id !== sessionId)
        .map((id) => titles.get(id))
        .filter((title): title is string => Boolean(title));
      const input = await gatherBriefing({
        earlier,
        git: remote ? this.envs.kit(remote).git : this.deps.git,
        onError: (step, error) => warn(`could not read ${step}`, error),
        target: remote ? remote.target : project,
        task,
        variant,
      });
      await client.putInstruction(
        sessionId,
        BRIEFING_KEY,
        buildBriefing(input),
        variant.directory
      );
    } catch (error) {
      warn("not attached", error);
    }
  }

  /** Closes a task conversation; cleanup removes its opencode session later. */
  async archiveTaskConversation(
    id: ProjectId,
    sessionId: string
  ): Promise<void> {
    this.envs.requireProject(id);
    const found = this.deps.tasks.bySession(sessionId);
    if (
      !found ||
      found.task.projectId !== id ||
      found.variant.discarded ||
      this.deps.tasks.isSessionArchived(sessionId)
    ) {
      throw new NotFoundError(sessionId, "task conversation");
    }
    const session = this.deps.store
      .sessionsOf(id)
      .find((s) => s.id === sessionId);
    if (session && session.status !== "idle") {
      await this.envs
        .opencodeClient(session.envId ?? id)
        .interrupt(sessionId, session.directory);
    }
    this.deps.tasks.archiveSession(sessionId);
  }

  latestSession(id: ProjectId, directory: string): SessionSummary | undefined {
    return this.deps.store
      .sessionsOf(id)
      .filter((s) => s.directory === directory)
      .toSorted((a, b) => b.updatedAt - a.updatedAt)[0];
  }
}
