import { deriveTitle } from "../../shared/tasks";
import type {
  ChatLookup,
  ChatStartRequest,
  ChatStartResult,
  ChatSuggestions,
  MakeTaskRequest,
  ProjectId,
} from "../../shared/types";
import type { ChatRecord } from "../db/chats";
import { USER } from "../db/events";
import { ChatTakenError } from "../db/tasks";
import type { Environments } from "../environments/environments";
import type { HubDeps } from "../environments/ports";
import { NotFoundError, UnavailableError } from "../errors";
import { InvalidRequestError } from "../git/worktrees";
import { LOCAL_NODE } from "../nodes/host";
import { CHAT_ID, newTaskId } from "../projects/ids";
import type { CheckoutSetup, SetupSink } from "../tasks/checkout-setup";
import { NO_WORKTREE_MOUNT } from "../tasks/checkout-setup";
import { PROPOSE_COMMAND } from "../tasks/openspec";
import { parseFirstMessage, parseJiraTaskSource } from "../tasks/request";
import type { Tasks } from "../tasks/tasks";
import type { Sessions } from "./sessions";

/** What Make task asks the chat's own session for, without adding to its history. */
export const BRIEF_PROMPT =
  "Write a brief for a task that continues this conversation, in Markdown, with these sections: Goal (one or two sentences), Decisions so far, Open questions, Constraints. Leave out a section that would be empty. Reply with the brief only.";

/** Jira keys, as Make task suggests them from a branch name and the user's messages. */
const TICKET_KEY = /\b[A-Z][A-Z0-9]+-\d+\b/gu;
/** User messages scanned for ticket keys, newest first. */
const SCANNED_MESSAGES = 50;

/** Chats: the start composer's first message starts one, in a new worktree or one of the project's checkouts. */
export class Chat {
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  private readonly sessions: Sessions;
  private readonly setup: CheckoutSetup;
  private readonly tasks: Tasks;
  constructor(
    deps: HubDeps,
    envs: Environments,
    sessions: Sessions,
    setup: CheckoutSetup,
    tasks: Tasks
  ) {
    this.deps = deps;
    this.envs = envs;
    this.sessions = sessions;
    this.setup = setup;
    this.tasks = tasks;
  }

  /**
   * A new worktree gets a chat at once, and is set up in the background on the project's defaults with a branch
   * named from the message, whose first turn is the message; the chat id comes back meanwhile. A checkout gets a new
   * conversation, recorded as a chat, and the message is sent to it before answering. Neither creates a task.
   */
  async start(
    id: ProjectId,
    request: ChatStartRequest
  ): Promise<ChatStartResult> {
    const message = parseFirstMessage(request.message);
    const { target } = request;
    if (target.kind === "checkout") {
      const started = await this.sessions.startWithMessage(
        id,
        target.directory,
        message
      );
      return { chat: started.chat, sessionId: started.sessionId };
    }
    const client = this.envs.opencodeClient(id);
    const project = this.envs.requireProject(id);
    if (!this.deps.store.runtime(id).worktreeRoot?.mounted) {
      throw new UnavailableError(NO_WORKTREE_MOUNT);
    }
    const title = deriveTitle(message.text);
    const chat = this.deps.chats.insert(
      {
        createdAt: (this.deps.now ?? Date.now)(),
        origin: "hub",
        projectId: id,
        step: "queued",
        title,
      },
      USER
    );
    void this.setup
      .run(project, client, {
        label: `chat ${title}`,
        node: LOCAL_NODE,
        slots: [
          {
            sessionTitle: title,
            sink: this.chatSink(chat.id),
            spec: {
              ...(message.model ? { model: message.model } : {}),
              ...(message.agent ? { agent: message.agent } : {}),
            },
          },
        ],
        title,
        turn: { message },
        where: "worktree",
      })
      .catch(() => undefined);
    return { chat: chat.id };
  }

  /** A chat, or for one a task adopted, the task and variant it became. */
  lookup(id: ProjectId, chatId: string): ChatLookup {
    const chat = this.require(id, chatId);
    if (chat.adoptedBy) {
      return { adoptedBy: chat.adoptedBy };
    }
    const listed = this.deps.store.chatsOf(id).find((c) => c.id === chatId);
    const {
      projectId: _projectId,
      archivedAt: _archivedAt,
      branchId: _branchId,
      ...view
    } = chat;
    return { chat: listed ?? view };
  }

  /** Hides a chat from every list; its session keeps running. */
  archive(id: ProjectId, chatId: string): void {
    this.require(id, chatId);
    this.deps.chats.archive(chatId, USER);
  }

  /** A brief for Make task, drafted by the chat's own session from its context; its transcript gains nothing. */
  async brief(id: ProjectId, chatId: string): Promise<{ brief: string }> {
    const chat = this.require(id, chatId);
    if (!chat.sessionId || !chat.directory) {
      throw new InvalidRequestError("the chat has no conversation yet");
    }
    const text = await this.envs
      .opencodeClient(chat.envId ?? id)
      .generate(chat.sessionId, BRIEF_PROMPT, chat.directory);
    return { brief: text.trim() };
  }

  /** The links Make task suggests: Jira keys in the branch and the user's messages, and the branch's pull request. */
  async suggestions(id: ProjectId, chatId: string): Promise<ChatSuggestions> {
    const chat = this.require(id, chatId);
    const messages =
      chat.sessionId && !chat.sessionRemoved
        ? await this.envs
            .opencodeClient(chat.envId ?? id)
            .userMessages(chat.sessionId, SCANNED_MESSAGES)
            .catch(() => [])
        : [];
    const keys = [
      ...(chat.branch?.toUpperCase().match(TICKET_KEY) ?? []),
      ...messages.toReversed().flatMap((m) => m.text.match(TICKET_KEY) ?? []),
    ];
    const head = chat.branch
      ? this.deps.checkouts.branch(id, chat.branch)?.pullRequest
      : undefined;
    const pull =
      head?.role === "head" ? this.deps.links.pull(head.url) : undefined;
    return {
      pullRequests:
        head?.role === "head"
          ? [
              {
                url: head.url,
                ...(pull?.title ? { title: pull.title } : {}),
                ...(pull?.number === undefined ? {} : { number: pull.number }),
              },
            ]
          : [],
      tickets: [...new Set(keys)],
    };
  }

  /**
   * Makes a task of a chat in a worktree: the task adopts the chat's session as its variant 1, with nothing sent to
   * it. With `spec`, the conversation then runs `opsx-propose <brief>`; extra variants start afterwards in new
   * worktrees from the chat branch's base, and one failing leaves the task and variant 1 as they are.
   */
  async makeTask(
    id: ProjectId,
    chatId: string,
    body: MakeTaskRequest
  ): Promise<{ task: string }> {
    const chat = this.require(id, chatId);
    const project = this.envs.requireProject(id);
    if (chat.adoptedBy) {
      throw new InvalidRequestError("the chat already belongs to a task");
    }
    if (!chat.sessionId || chat.sessionRemoved) {
      throw new InvalidRequestError("the chat's conversation is gone");
    }
    if (!chat.branch || chat.directory === this.envs.workspaceFolder(project)) {
      throw new InvalidRequestError(
        "only a chat in a worktree can become a task"
      );
    }
    const title = body.title.trim() || chat.title;
    const brief = body.brief.trim();
    const spec = body.spec === true;
    if (spec && !brief) {
      throw new InvalidRequestError("a spec needs a brief to propose from");
    }
    const ticket =
      body.ticket === undefined ? undefined : parseJiraTaskSource(body.ticket);
    const session = this.deps.store
      .sessionsOf(id)
      .find((s) => s.id === chat.sessionId);
    const now = (this.deps.now ?? Date.now)();
    const task = newTaskId(now);
    try {
      this.deps.tasks.adoptChat(
        {
          chat,
          task: {
            createdAt: now,
            id: task,
            prompt: brief,
            specFirst: spec,
            title,
            ...(ticket ? { jira: ticket } : {}),
            ...(body.pullRequest?.trim()
              ? { pullUrl: body.pullRequest.trim() }
              : {}),
            ...(session?.model ? { model: session.model } : {}),
          },
        },
        USER
      );
    } catch (error) {
      if (error instanceof ChatTakenError) {
        throw new InvalidRequestError("the chat already belongs to a task");
      }
      throw error;
    }
    if (spec) {
      await this.envs
        .opencodeClient(chat.envId ?? id)
        .command(
          chat.sessionId,
          PROPOSE_COMMAND,
          brief,
          chat.directory ?? "",
          {}
        )
        .catch((error: unknown) => {
          const why = `could not run ${PROPOSE_COMMAND}: ${error instanceof Error ? error.message : String(error)}`;
          this.envs.log(id, `task ${title}: ${why}`);
          // Shown on the variant, which otherwise waits for a proposal that never comes.
          this.deps.tasks.updateVariant(
            task,
            1,
            { error: `${why}; run it in the conversation` },
            USER
          );
        });
    }
    const extra = body.variants ?? [];
    if (extra.length > 0) {
      const base = this.deps.checkouts.branch(id, chat.branch)?.base;
      void this.tasks
        .addVariants(id, task, extra, {
          spec,
          ...(base ? { base } : {}),
        })
        .catch((error: unknown) =>
          this.envs.log(
            id,
            `task ${title}: could not add variants: ${error instanceof Error ? error.message : String(error)}`
          )
        );
    }
    this.envs.reconcile(chat.envId ?? id);
    return { task };
  }

  /** The project's chat `chatId`; throws when there is no such chat or it is internal. */
  require(id: ProjectId, chatId: string): ChatRecord {
    this.envs.requireProject(id);
    const chat = CHAT_ID.test(chatId) ? this.deps.chats.get(chatId) : undefined;
    if (!chat || chat.projectId !== id || chat.origin === "internal") {
      throw new NotFoundError(chatId, "chat");
    }
    return chat;
  }

  /** Where a new worktree chat's setup reports: its row, its log, and its session. */
  private chatSink(chatId: string): SetupSink {
    const { chats, store } = this.deps;
    return {
      actor: USER,
      attach: (session) => chats.attachSession(chatId, session),
      created: (rows) => chats.update(chatId, rows),
      creator: { by: "manual" },
      log: (line) => store.appendSetupLog(chatId, line),
      step: (patch) => chats.update(chatId, patch),
    };
  }
}
