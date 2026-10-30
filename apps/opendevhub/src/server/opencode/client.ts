import nodePath from "node:path";
import { pathToFileURL } from "node:url";

import type {
  ComposerMention,
  FormAnswer,
  FormField,
  ModelRef,
  PermissionDecision,
} from "../../shared/types";

export interface OpencodeEndpoint {
  baseUrl: string;
  password: string;
}

export interface RawTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface RawSession {
  id: string;
  title?: string;
  parentID?: string;
  /** opencode's project: one per repository, shared by its worktrees. */
  projectID?: string;
  time: { created: number; updated: number; archived?: number };
  location: { directory: string };
  metadata?: Record<string, unknown>;
  model?: ModelRef;
  agent?: string;
  /** USD. */
  cost?: number;
  tokens?: RawTokens;
  outcome?: "succeeded" | "failed" | "interrupted";
  /** A staged revert: messages from `messageID` on are rewound, and `files` were restored from the snapshot. */
  revert?: RawRevert;
}

/** The fields of opencode's `Session.Revert` that opendevhub reads. */
export interface RawRevert {
  messageID: string;
  files?: RawFileDiff[];
}

/** One piece of an assistant message: text, reasoning or a tool call. */
export interface RawAssistantContent {
  type: string;
  /** Set on text and reasoning. */
  text?: string;
  /** Set on reasoning: when the model started thinking and, once it stopped, when it did. */
  time?: { created: number; completed?: number };
  /** Set on a tool call. */
  name?: string;
  /**
   * Set on a tool call: its status, "pending", "running", "completed" or "error", and what it did, such as the
   * command it ran, when opencode gives one; a shell call's `metadata.shellID` names the shell it runs. `input` is
   * what the agent called it with (a string while it is still being written), `content` what it returned and
   * `error` why it failed.
   */
  state?: {
    status: string;
    title?: string;
    metadata?: Record<string, unknown>;
    input?: Record<string, unknown> | string;
    content?: { type: string; text?: string }[];
    error?: { message?: string };
  };
}

/** The fields of a session message that opendevhub reads. */
export interface RawMessage {
  id: string;
  /** "user", "assistant", "synthetic", "compaction" and more. */
  type: string;
  time?: { created: number; completed?: number };
  /** A user message's prompt. */
  text?: string;
  /** A user message's files: its `@` mentions (with a `mention`) and what was attached from the user's machine. */
  files?: RawFileAttachment[];
  /** The rest are an assistant message's. */
  agent?: string;
  model?: ModelRef;
  content?: RawAssistantContent[];
  /** USD. */
  cost?: number;
  tokens?: RawTokens;
  /** Why the model stopped, such as "stop" or "tool-calls". */
  finish?: string;
  error?: { message?: string };
  /** The files this message changed. */
  snapshot?: { files?: string[] };
}

/**
 * The fields of opencode's Model.Info that opendevhub reads. The rest (`settings`, `headers`, `body`) can hold
 * API keys and must never be passed on.
 */
export interface RawModel {
  id: string;
  providerID: string;
  name: string;
  enabled?: boolean;
  status?: string;
  variants?: { id: string }[];
  limit?: { context?: number };
}

/** One of a session's instruction entries, as `putInstruction` set it. */
export interface RawInstruction {
  key: string;
  value: unknown;
}

export interface RawAgent {
  id: string;
  name: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  description?: string;
}

/** A slash command opencode knows, from the repo's or the user's config. */
export interface RawCommand {
  name: string;
  description?: string;
}

/** A mention's range in the text it was sent with, and that text (`@src/a.ts`, `@explore`). */
export interface RawMention {
  start: number;
  end: number;
  text: string;
}

/** A file opencode reads into the prompt itself; `uri` is `file://<absolute path>` or a `data:` URL. */
export interface RawFileAttachment {
  uri: string;
  name?: string;
  mention?: RawMention;
}

/** An agent the prompt asks for; opencode passes it to the model and keeps the session's own agent. */
export interface RawAgentAttachment {
  name: string;
  mention?: RawMention;
}

/** What `@` mentions turn into, for `prompt` and `command` alike (opencode 2.0.26's PromptInput). */
export interface PromptAttachments {
  files?: RawFileAttachment[];
  agents?: RawAgentAttachment[];
}

/** One `GET /api/fs/find` match: a path relative to the checkout; directories end in `/`. */
export interface RawFsEntry {
  path: string;
  type: "file" | "directory";
}

export interface NewSession {
  title?: string;
  model?: ModelRef;
  agent?: string;
  metadata?: Record<string, unknown>;
}

export interface RawPermissionRequest {
  id: string;
  sessionID: string;
  action: string;
  resources?: string[];
  save?: string[];
  message?: string;
  metadata?: Record<string, unknown>;
}

/** opencode's PermissionSaved.Info: an allow rule saved from an "always" answer. */
export interface RawSavedPermission {
  id: string;
  projectID: string;
  action: string;
  resource: string;
  time: { created: number; updated: number };
}

export interface RawForm {
  id: string;
  sessionID: string;
  title: string;
  fields?: FormField[];
}

/** A shell command opencode runs (opencode v2 `Shell.Info`); background ones outlive the tool call that started it. */
export interface RawShell {
  id: string;
  status: "running" | "exited" | "timeout" | "killed";
  command: string;
  cwd: string;
  /** Opaque tags from whoever started it; opencode's shell tool sets `sessionID`. */
  metadata?: Record<string, unknown>;
  time: { started: number; completed?: number };
}

export interface RawFileStatus {
  file: string;
  additions: number;
  deletions: number;
  status: "added" | "deleted" | "modified";
}

export interface RawFileDiff extends RawFileStatus {
  patch: string;
}

/** The fields of a user message that opendevhub reads. */
export interface RawUserMessage {
  id: string;
  text: string;
  time: { created: number };
}

export interface OpencodeEvent {
  type: string;
  location?: { directory: string };
  data?: Record<string, unknown>;
}

export class OpencodeHttpError extends Error {
  readonly status: number;
  /** opencode's error `_tag`, e.g. "FormNotFound", when the body was JSON. */
  readonly tag?: string;
  /** opencode's error message, when it sent one. */
  readonly detail?: string;
  constructor(status: number, path: string, tag?: string, detail?: string) {
    super(
      `opencode ${path} responded ${status}${tag ? ` ${tag}` : ""}${detail ? `: ${detail}` : ""}`
    );
    this.status = status;
    this.tag = tag;
    this.detail = detail;
    this.name = "OpencodeHttpError";
  }
}

// opencode 2.0.22 answers 404 PermissionNotFoundError/FormNotFoundError and 409 FormAlreadySettledError; 2.1.0
// answers 404 PermissionSavedNotFoundError for a saved rule.
const GONE_TAGS = new Set([
  "PermissionNotFoundError",
  "PermissionSavedNotFoundError",
  "FormNotFoundError",
  "FormAlreadySettledError",
]);

/** opencode no longer has the item: it was answered or cancelled in another client. */
export const isGone = (err: unknown): err is OpencodeHttpError =>
  err instanceof OpencodeHttpError && gone(err);

const gone = (err: OpencodeHttpError): boolean =>
  err.status === 404 ||
  err.status === 409 ||
  (err.tag !== undefined && GONE_TAGS.has(err.tag));

/** opencode rejected a form answer; `detail` says why. */
export const isInvalidAnswer = (err: unknown): err is OpencodeHttpError => {
  if (!(err instanceof OpencodeHttpError) || gone(err)) {
    return false;
  }
  return err.tag === "FormInvalidAnswerError" || err.status === 400;
};

/** A path relative to a checkout that stays inside it: no absolute path, no `..`, no empty segment. */
const insideCheckout = (path: string): boolean =>
  path !== "" &&
  !path.startsWith("/") &&
  !path.includes("\\") &&
  path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");

/**
 * The composer's mentions as opencode's prompt attachments, encoded as opencode's own clients do: the text keeps
 * `@<path>` or `@<agent>`, and the attachment carries its range. A file becomes a `file://` URI under `directory`.
 * `offset` is where `text` begins in the composer's message (a command's arguments start after `/name `); mentions
 * before it are dropped. Throws on a mention whose range doesn't match the text or whose path leaves the checkout,
 * since opencode reads any `file://` path it is given.
 */
export const toAttachments = (
  directory: string,
  message: string,
  mentions: readonly ComposerMention[],
  offset = 0
): PromptAttachments => {
  const files: RawFileAttachment[] = [];
  const agents: RawAgentAttachment[] = [];
  for (const m of mentions) {
    const token = message.slice(m.start, m.end);
    if (m.end <= m.start || token !== `@${m.name}`) {
      throw new RangeError(`mention "${m.name}" doesn't match the message`);
    }
    if (m.start < offset) {
      continue;
    }
    const mention = {
      end: m.end - offset,
      start: m.start - offset,
      text: token,
    };
    if (m.kind === "agent") {
      agents.push({ mention, name: m.name });
      continue;
    }
    if (!insideCheckout(m.name)) {
      throw new RangeError(`"${m.name}" isn't a file in the checkout`);
    }
    files.push({
      mention,
      name: m.name,
      uri: pathToFileURL(nodePath.posix.join(directory, m.name)).href,
    });
  }
  return {
    ...(files.length > 0 ? { files } : {}),
    ...(agents.length > 0 ? { agents } : {}),
  };
};

export const basicAuth = (password: string): string =>
  `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

const REQUEST_TIMEOUT_MS = 5000;
/** For a prompt or command carrying inline files, which can be megabytes. */
const UPLOAD_TIMEOUT_MS = 60_000;
const DIFF_TIMEOUT_MS = 30_000;
const GENERATE_TIMEOUT_MS = 60_000;
/** `allSessions` reads this many per request and stops after `ALL_SESSIONS_CAP`. */
const SESSION_PAGE_SIZE = 200;
export const ALL_SESSIONS_CAP = 2000;

const timeoutOf = (attachments: PromptAttachments): number =>
  attachments.files?.some((f) => f.uri.startsWith("data:"))
    ? UPLOAD_TIMEOUT_MS
    : REQUEST_TIMEOUT_MS;

/** AbortSignal.timeout() rejects with this abort reason; say what actually ran out instead. */
const isRequestTimeout = (error: unknown): boolean => {
  const e = error as { name?: unknown; message?: unknown } | undefined;
  return (
    e?.name === "TimeoutError" ||
    (typeof e?.message === "string" &&
      /aborted due to timeout/iu.test(e.message))
  );
};

const requestTimeoutMessage = (
  method: string,
  path: string,
  timeoutMs: number
): string =>
  `opencode did not respond to ${method} ${path} within ${Math.round(timeoutMs / 1000)} s`;

export class OpencodeClient {
  private readonly ep: OpencodeEndpoint;
  private readonly fetchImpl: typeof fetch;
  constructor(ep: OpencodeEndpoint, fetchImpl: typeof fetch = fetch) {
    this.ep = ep;
    this.fetchImpl = fetchImpl;
  }

  private async get<T>(
    path: string,
    directory?: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: basicAuth(this.ep.password),
    };
    if (directory) {
      headers["x-opencode-directory"] = directory;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.ep.baseUrl + path, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw isRequestTimeout(error)
        ? new Error(requestTimeoutMessage("GET", path, timeoutMs))
        : error;
    }
    if (!res.ok) {
      throw new OpencodeHttpError(res.status, path);
    }
    return (await res.json()) as T;
  }

  /** Starts a session whose working directory is `directory` (the workspace or one of its worktrees). */
  async createSession(
    directory: string,
    opts: NewSession = {},
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<RawSession> {
    const body = {
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
      location: { directory },
    };
    const res = await this.request(
      "POST",
      "/api/session",
      body,
      directory,
      timeoutMs
    );
    const created = (await res.json()) as {
      data?: RawSession;
    } & Partial<RawSession>;
    // Accept both the `{ data }` envelope used by the list routes and a bare session.
    return (created.data ?? created) as RawSession;
  }

  private async request(
    method: "POST" | "PUT" | "DELETE" | "PATCH",
    path: string,
    body?: unknown,
    directory?: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: basicAuth(this.ep.password),
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (directory) {
      headers["x-opencode-directory"] = directory;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.ep.baseUrl + path, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        method,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw isRequestTimeout(error)
        ? new Error(requestTimeoutMessage(method, path, timeoutMs))
        : error;
    }
    if (res.ok) {
      return res;
    }
    const err = (await res.json().catch(() => ({}))) as {
      _tag?: unknown;
      message?: unknown;
    };
    throw new OpencodeHttpError(
      res.status,
      path,
      typeof err._tag === "string" ? err._tag : undefined,
      typeof err.message === "string" ? err.message : undefined
    );
  }

  private async send(
    method: "POST" | "PUT" | "DELETE" | "PATCH",
    path: string,
    body?: unknown,
    directory?: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<void> {
    const res = await this.request(method, path, body, directory, timeoutMs);
    await res.text().catch(() => "");
  }

  /** Answers a permission request; `sessionId` is the session that asked (may be a subagent). */
  replyPermission(
    sessionId: string,
    requestId: string,
    reply: { decision: PermissionDecision; message?: string },
    directory?: string
  ): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`;
    return this.send("POST", path, reply, directory);
  }

  replyForm(
    sessionId: string,
    formId: string,
    answer: FormAnswer,
    directory?: string
  ): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`;
    return this.send("POST", path, { answer }, directory);
  }

  /** Cancels a form. opencode 2.0.22's DELETE takes no reason, so the agent only learns it was cancelled. */
  cancelForm(
    sessionId: string,
    formId: string,
    directory?: string
  ): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`;
    return this.send("DELETE", path, undefined, directory);
  }
  async vcsInfo(
    directory: string
  ): Promise<{ current?: string; default?: string }> {
    const result = await this.get<{
      data: { branch: { current?: string; default?: string } };
    }>("/api/vcs", directory);
    return result.data.branch;
  }

  /** opencode's guess at the review base; undefined when it has none or can't tell (503 "Choose a review base"). */
  async vcsBase(directory: string): Promise<string | undefined> {
    try {
      const result2 = await this.get<{ data: { name: string } | null }>(
        "/api/vcs/base",
        directory
      );
      return result2.data?.name || undefined;
    } catch (error) {
      if (error instanceof OpencodeHttpError && error.status === 503) {
        return undefined;
      }
      throw error;
    }
  }

  async vcsStatus(directory: string): Promise<RawFileStatus[]> {
    const result3 = await this.get<{ data: RawFileStatus[] }>(
      "/api/vcs/status",
      directory
    );
    return result3.data;
  }

  async vcsDiff(
    directory: string,
    mode: "working" | "branch",
    base?: string
  ): Promise<RawFileDiff[]> {
    const query = new URLSearchParams({ mode, ...(base ? { base } : {}) });
    const result4 = await this.get<{ data: RawFileDiff[] }>(
      `/api/vcs/diff?${query}`,
      directory,
      DIFF_TIMEOUT_MS
    );
    return result4.data;
  }

  /**
   * What a session changed in one turn (`from`, the newest by default), or across turns up to `to`; whole-file
   * patches, like `vcsDiff`. A turn still running compares with the working copy.
   */
  async sessionDiff(
    sessionId: string,
    opts: { from?: string; to?: string } = {},
    directory?: string
  ): Promise<RawFileDiff[]> {
    const query = new URLSearchParams({
      ...(opts.from ? { from: opts.from } : {}),
      ...(opts.to ? { to: opts.to } : {}),
    });
    const result = await this.get<{ data: RawFileDiff[] }>(
      `/api/session/${encodeURIComponent(sessionId)}/diff${query.size ? `?${query}` : ""}`,
      directory,
      DIFF_TIMEOUT_MS
    );
    return result.data;
  }

  /**
   * Stages a revert at user message `messageId`, or moves a staged one there, restoring the checkout's files from
   * the turn's snapshot. opencode refuses with `SessionBusyError` while the session runs.
   */
  async stageRevert(
    sessionId: string,
    messageId: string,
    directory?: string
  ): Promise<RawRevert> {
    const res = await this.request(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/revert/stage`,
      { files: true, messageID: messageId },
      directory,
      DIFF_TIMEOUT_MS
    );
    const staged = (await res.json()) as {
      data?: RawRevert;
    } & Partial<RawRevert>;
    return (staged.data ?? staged) as RawRevert;
  }

  /** Clears the staged revert, bringing back its messages and the files as they were before the first stage. */
  clearRevert(sessionId: string, directory?: string): Promise<void> {
    return this.send(
      "DELETE",
      `/api/session/${encodeURIComponent(sessionId)}/revert`,
      undefined,
      directory,
      DIFF_TIMEOUT_MS
    );
  }

  /** Makes the staged revert permanent, dropping its messages. */
  commitRevert(sessionId: string, directory?: string): Promise<void> {
    return this.send(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/revert/commit`,
      undefined,
      directory
    );
  }

  /**
   * Adds a user message; asynchronous on opencode's side. `queue` waits for a running agent to finish its turn.
   * `attachments` are the message's `@` mentions (see `toAttachments`).
   */
  prompt(
    sessionId: string,
    text: string,
    delivery?: "queue" | "steer",
    directory?: string,
    attachments: PromptAttachments = {},
    timeoutMs = timeoutOf(attachments)
  ): Promise<void> {
    return this.send(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/prompt`,
      { text, ...attachments, ...(delivery ? { delivery } : {}) },
      directory,
      timeoutMs
    );
  }

  /**
   * Runs a slash command in the session, `text` being its arguments; opencode expands it as typed `/name text`.
   * Takes the same attachments and delivery as `prompt`.
   */
  command(
    sessionId: string,
    name: string,
    text: string,
    directory?: string,
    opts: PromptAttachments & {
      delivery?: "queue" | "steer";
      timeoutMs?: number;
    } = {}
  ): Promise<void> {
    const { timeoutMs, ...rest } = opts;
    return this.send(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/command`,
      { name, text, ...rest },
      directory,
      timeoutMs ?? timeoutOf(opts)
    );
  }

  /**
   * Attaches or replaces the session's instruction entry `key`, which the agent reads as context rather than as a
   * turn. opencode 2.0.27 marks the route experimental: `PUT /api/experimental/session/:id/instructions/entries/:key`.
   * An entry set before the first prompt joins the session's first instructions; a later change is announced at
   * the next step.
   */
  putInstruction(
    sessionId: string,
    key: string,
    value: unknown,
    directory?: string
  ): Promise<void> {
    return this.send(
      "PUT",
      `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries/${encodeURIComponent(key)}`,
      { value },
      directory
    );
  }

  /** The session's instruction entries, by key; experimental like `putInstruction`. */
  async instructions(
    sessionId: string,
    directory?: string
  ): Promise<RawInstruction[]> {
    const result = await this.get<{ data: RawInstruction[] }>(
      `/api/experimental/session/${encodeURIComponent(sessionId)}/instructions/entries`,
      directory
    );
    return result.data;
  }

  /** Sets the model the session's next turns use. */
  /** Switches the primary agent the session's next turns use. */
  switchAgent(
    sessionId: string,
    agent: string,
    directory?: string
  ): Promise<void> {
    return this.send(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/agent`,
      { agent },
      directory
    );
  }

  switchModel(
    sessionId: string,
    model: ModelRef,
    directory?: string
  ): Promise<void> {
    return this.send(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/model`,
      { model },
      directory
    );
  }

  /** Files in the checkout whose path fuzzily matches `query`, best first; opencode skips what `.gitignore` lists. */
  async findFiles(
    directory: string,
    query: string,
    limit: number
  ): Promise<string[]> {
    const params = new URLSearchParams({
      limit: String(limit),
      query,
      type: "file",
    });
    const result = await this.get<{ data: RawFsEntry[] }>(
      `/api/fs/find?${params}`,
      directory
    );
    return result.data
      .filter((e) => e.type === "file")
      .slice(0, limit)
      .map((e) => e.path);
  }

  /** Stops the session's running turn. */
  interrupt(sessionId: string, directory?: string): Promise<void> {
    return this.send(
      "POST",
      `/api/session/${encodeURIComponent(sessionId)}/interrupt`,
      undefined,
      directory
    );
  }

  /** Text generated from the session's context, without adding to its history. */
  async generate(
    sessionId: string,
    prompt: string,
    directory?: string,
    timeoutMs = GENERATE_TIMEOUT_MS
  ): Promise<string> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/generate`;
    const res = await this.request(
      "POST",
      path,
      { prompt },
      directory,
      timeoutMs
    );
    return ((await res.json()) as { data: { text: string } }).data.text;
  }

  async models(directory: string): Promise<RawModel[]> {
    const result5 = await this.get<{ data: RawModel[] }>(
      "/api/model",
      directory
    );
    return result5.data;
  }

  async defaultModel(directory: string): Promise<RawModel | undefined> {
    const result6 = await this.get<{ data: RawModel | null }>(
      "/api/model/default",
      directory
    );
    return result6.data ?? undefined;
  }

  async agents(directory: string): Promise<RawAgent[]> {
    const result7 = await this.get<{ data: RawAgent[] }>(
      "/api/agent",
      directory
    );
    return result7.data;
  }

  async commands(
    directory: string,
    timeoutMs = REQUEST_TIMEOUT_MS
  ): Promise<RawCommand[]> {
    const result = await this.get<{ data: RawCommand[] }>(
      "/api/command",
      directory,
      timeoutMs
    );
    return result.data;
  }

  /** opencode replaces `metadata` as a whole, so pass every key the session should keep. */
  updateSession(
    id: string,
    patch: { title?: string; metadata?: Record<string, unknown> },
    directory?: string
  ): Promise<void> {
    return this.send(
      "PATCH",
      `/api/session/${encodeURIComponent(id)}`,
      patch,
      directory
    );
  }

  /**
   * Archives or unarchives a session (opencode 2.1+: stamps or clears `time.archived`). 2.0.x answers 204 too but
   * ignores it, so callers check the version first.
   */
  setArchived(
    id: string,
    archived: boolean,
    directory?: string
  ): Promise<void> {
    return this.send(
      "PATCH",
      `/api/session/${encodeURIComponent(id)}`,
      { archived },
      directory
    );
  }

  /** Deletes a session; opencode deletes its child (subagent) sessions with it. */
  deleteSession(id: string, directory?: string): Promise<void> {
    return this.send(
      "DELETE",
      `/api/session/${encodeURIComponent(id)}`,
      undefined,
      directory
    );
  }

  info(): Promise<{ version: string }> {
    return this.get("/api/info");
  }

  /** The newest page of sessions only (opencode's default is 50); see `allSessions` for every one. */
  async sessions(): Promise<RawSession[]> {
    const result8 = await this.get<{ data: RawSession[] }>("/api/session");
    return result8.data;
  }

  /**
   * Every session, newest first, following the list cursor up to `cap`; `onCapped` runs when it stops there. The
   * cursor carries the list's filters, so later pages pass only it. opencode 2.1 still gives a `next` on the last
   * page, and the page after it is empty.
   */
  async allSessions(
    opts: { cap?: number; onCapped?: (cap: number) => void } = {}
  ): Promise<RawSession[]> {
    const cap = opts.cap ?? ALL_SESSIONS_CAP;
    const all: RawSession[] = [];
    let path = `/api/session?limit=${SESSION_PAGE_SIZE}`;
    while (all.length < cap) {
      const page = await this.get<{
        data: RawSession[];
        cursor?: { next?: string | null };
      }>(path);
      all.push(...page.data);
      const next = page.cursor?.next;
      if (page.data.length === 0 || !next) {
        return all.slice(0, cap);
      }
      path = `/api/session?cursor=${encodeURIComponent(next)}`;
    }
    opts.onCapped?.(cap);
    return all.slice(0, cap);
  }

  /** Direct child sessions, filtered before opencode applies the session page limit. */
  async childSessions(parentId: string): Promise<RawSession[]> {
    const result = await this.get<{ data: RawSession[] }>(
      `/api/session?parentID=${encodeURIComponent(parentId)}`
    );
    return result.data;
  }

  async session(id: string): Promise<RawSession> {
    const result9 = await this.get<{ data: RawSession }>(
      `/api/session/${encodeURIComponent(id)}`
    );
    return result9.data;
  }

  /** A session's newest `limit` messages, newest first. */
  async messages(sessionId: string, limit: number): Promise<RawMessage[]> {
    const result = await this.get<{ data: RawMessage[] }>(
      `/api/session/${encodeURIComponent(sessionId)}/message?limit=${limit}&order=desc`
    );
    return result.data;
  }

  /** A session's newest `limit` user messages, newest first: the prompts its turns start from. */
  async userMessages(
    sessionId: string,
    limit: number
  ): Promise<RawUserMessage[]> {
    const result = await this.get<{ data: RawUserMessage[] }>(
      `/api/session/${encodeURIComponent(sessionId)}/message?type=user&limit=${limit}&order=desc`
    );
    return result.data;
  }

  async active(): Promise<Set<string>> {
    const r = await this.get<{ data: Record<string, unknown> }>(
      "/api/session/active"
    );
    return new Set(Object.keys(r.data));
  }

  async permissionRequests(directory: string): Promise<RawPermissionRequest[]> {
    const result10 = await this.get<{ data: RawPermissionRequest[] }>(
      "/api/permission/request",
      directory
    );
    return result10.data;
  }

  /** opencode's projects; a bare array, not the `{ data }` envelope. */
  projects(): Promise<{ id: string }[]> {
    return this.get("/api/project");
  }

  /** The rules saved from "always" answers, of one opencode project or of all of them. */
  async savedPermissions(projectID?: string): Promise<RawSavedPermission[]> {
    const query = projectID ? `?${new URLSearchParams({ projectID })}` : "";
    const result = await this.get<{ data: RawSavedPermission[] }>(
      `/api/permission/saved${query}`
    );
    return result.data;
  }

  /** Changes a saved rule (opencode 2.1+; 2.0.x has no such route and answers a bare 404). */
  async updateSavedPermission(
    id: string,
    patch: { action?: string; resource?: string }
  ): Promise<RawSavedPermission> {
    const res = await this.request(
      "PATCH",
      `/api/permission/saved/${encodeURIComponent(id)}`,
      patch
    );
    return ((await res.json()) as { data: RawSavedPermission }).data;
  }

  /** Removes a saved rule, so opencode asks again; a missing one answers 204 too. */
  deleteSavedPermission(id: string): Promise<void> {
    return this.send(
      "DELETE",
      `/api/permission/saved/${encodeURIComponent(id)}`
    );
  }

  async forms(directory: string): Promise<RawForm[]> {
    const result11 = await this.get<{ data: RawForm[] }>(
      "/api/form",
      directory
    );
    return result11.data;
  }

  /** The shell commands running in `directory`; opencode leaves out exited ones. */
  async shells(directory: string): Promise<RawShell[]> {
    const result = await this.get<{ data: RawShell[] }>(
      "/api/shell",
      directory
    );
    return result.data;
  }

  /** Kills a running shell command and forgets it. */
  killShell(shellId: string, directory?: string): Promise<void> {
    return this.send(
      "DELETE",
      `/api/shell/${encodeURIComponent(shellId)}`,
      undefined,
      directory
    );
  }

  /** Resolves when the stream ends; rejects on HTTP or network errors (including abort). */
  async subscribe(
    onEvent: (event: OpencodeEvent) => void,
    signal: AbortSignal
  ): Promise<void> {
    const res = await this.fetchImpl(`${this.ep.baseUrl}/api/event`, {
      headers: {
        accept: "text/event-stream",
        authorization: basicAuth(this.ep.password),
      },
      signal,
    });
    if (!res.ok || !res.body) {
      throw new OpencodeHttpError(res.status, "/api/event");
    }
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) {
          continue;
        }
        try {
          onEvent(JSON.parse(data) as OpencodeEvent);
        } catch {
          // ignore malformed event payloads
        }
      }
    }
  }
}
