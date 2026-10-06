import type { FormAnswer, FormField, ModelRef, PermissionDecision } from "../../shared/types";

export interface OpencodeEndpoint {
  baseUrl: string;
  password: string;
}

export interface RawSession {
  id: string;
  title?: string;
  parentID?: string;
  time: { created: number; updated: number; archived?: number };
  location: { directory: string };
  metadata?: Record<string, unknown>;
  model?: ModelRef;
  agent?: string;
  /** USD. */
  cost?: number;
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  outcome?: "succeeded" | "failed" | "interrupted";
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
}

export interface RawAgent {
  id: string;
  name: string;
  mode: "primary" | "subagent" | "all";
  hidden?: boolean;
  description?: string;
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

export interface RawForm {
  id: string;
  sessionID: string;
  title: string;
  fields?: FormField[];
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

export interface OpencodeEvent {
  type: string;
  location?: { directory: string };
  data?: Record<string, unknown>;
}

export class OpencodeHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
    /** opencode's error `_tag`, e.g. "FormNotFound", when the body was JSON. */
    readonly tag?: string,
    /** opencode's error message, when it sent one. */
    readonly detail?: string,
  ) {
    super(`opencode ${path} responded ${status}${tag ? ` ${tag}` : ""}${detail ? `: ${detail}` : ""}`);
    this.name = "OpencodeHttpError";
  }
}

// opencode 2.0.22 answers 404 PermissionNotFoundError/FormNotFoundError and 409 FormAlreadySettledError.
const GONE_TAGS = new Set(["PermissionNotFoundError", "FormNotFoundError", "FormAlreadySettledError"]);

/** opencode no longer has the item: it was answered or cancelled in another client. */
export function isGone(err: unknown): err is OpencodeHttpError {
  return err instanceof OpencodeHttpError && gone(err);
}

function gone(err: OpencodeHttpError): boolean {
  return err.status === 404 || err.status === 409 || (err.tag !== undefined && GONE_TAGS.has(err.tag));
}

/** opencode rejected a form answer; `detail` says why. */
export function isInvalidAnswer(err: unknown): err is OpencodeHttpError {
  if (!(err instanceof OpencodeHttpError) || gone(err)) return false;
  return err.tag === "FormInvalidAnswerError" || err.status === 400;
}

export function basicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

const REQUEST_TIMEOUT_MS = 5000;
const DIFF_TIMEOUT_MS = 30_000;
const GENERATE_TIMEOUT_MS = 60_000;

export class OpencodeClient {
  constructor(
    private readonly ep: OpencodeEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string, directory?: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    const headers: Record<string, string> = { authorization: basicAuth(this.ep.password), accept: "application/json" };
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchImpl(this.ep.baseUrl + path, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new OpencodeHttpError(res.status, path);
    return (await res.json()) as T;
  }

  /** Starts a session whose working directory is `directory` (the workspace or one of its worktrees). */
  async createSession(directory: string, opts: NewSession = {}): Promise<RawSession> {
    const body = {
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
      location: { directory },
    };
    const res = await this.request("POST", "/api/session", body, directory);
    const created = (await res.json()) as { data?: RawSession } & Partial<RawSession>;
    // Accept both the `{ data }` envelope used by the list routes and a bare session.
    return (created.data ?? created) as RawSession;
  }

  private async request(
    method: "POST" | "DELETE" | "PATCH",
    path: string,
    body?: unknown,
    directory?: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const headers: Record<string, string> = { authorization: basicAuth(this.ep.password), accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchImpl(this.ep.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return res;
    const err = (await res.json().catch(() => ({}))) as { _tag?: unknown; message?: unknown };
    throw new OpencodeHttpError(
      res.status,
      path,
      typeof err._tag === "string" ? err._tag : undefined,
      typeof err.message === "string" ? err.message : undefined,
    );
  }

  private async send(method: "POST" | "DELETE" | "PATCH", path: string, body?: unknown, directory?: string): Promise<void> {
    const res = await this.request(method, path, body, directory);
    await res.text().catch(() => "");
  }

  /** Answers a permission request; `sessionId` is the session that asked (may be a subagent). */
  replyPermission(
    sessionId: string,
    requestId: string,
    reply: { decision: PermissionDecision; message?: string },
    directory?: string,
  ): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`;
    return this.send("POST", path, reply, directory);
  }

  replyForm(sessionId: string, formId: string, answer: FormAnswer, directory?: string): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}/reply`;
    return this.send("POST", path, { answer }, directory);
  }

  /** Cancels a form. opencode 2.0.22's DELETE takes no reason, so the agent only learns it was cancelled. */
  cancelForm(sessionId: string, formId: string, directory?: string): Promise<void> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(formId)}`;
    return this.send("DELETE", path, undefined, directory);
  }
  async vcsInfo(directory: string): Promise<{ current?: string; default?: string }> {
    return (await this.get<{ data: { branch: { current?: string; default?: string } } }>("/api/vcs", directory)).data.branch;
  }

  /** opencode's guess at the review base; undefined when it has none or can't tell (503 "Choose a review base"). */
  async vcsBase(directory: string): Promise<string | undefined> {
    try {
      return (await this.get<{ data: { name: string } | null }>("/api/vcs/base", directory)).data?.name || undefined;
    } catch (err) {
      if (err instanceof OpencodeHttpError && err.status === 503) return undefined;
      throw err;
    }
  }

  async vcsStatus(directory: string): Promise<RawFileStatus[]> {
    return (await this.get<{ data: RawFileStatus[] }>("/api/vcs/status", directory)).data;
  }

  async vcsDiff(directory: string, mode: "working" | "branch", base?: string): Promise<RawFileDiff[]> {
    const query = new URLSearchParams({ mode, ...(base ? { base } : {}) });
    return (await this.get<{ data: RawFileDiff[] }>(`/api/vcs/diff?${query}`, directory, DIFF_TIMEOUT_MS)).data;
  }

  /** Adds a user message; asynchronous on opencode's side. `queue` waits for a running agent to finish its turn. */
  prompt(sessionId: string, text: string, delivery?: "queue" | "steer", directory?: string): Promise<void> {
    return this.send("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, { text, ...(delivery ? { delivery } : {}) }, directory);
  }

  /** Stops the session's running turn. */
  interrupt(sessionId: string, directory?: string): Promise<void> {
    return this.send("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`, undefined, directory);
  }

  /** Text generated from the session's context, without adding to its history. */
  async generate(sessionId: string, prompt: string, directory?: string): Promise<string> {
    const path = `/api/session/${encodeURIComponent(sessionId)}/generate`;
    const res = await this.request("POST", path, { prompt }, directory, GENERATE_TIMEOUT_MS);
    return ((await res.json()) as { data: { text: string } }).data.text;
  }

  async models(directory: string): Promise<RawModel[]> {
    return (await this.get<{ data: RawModel[] }>("/api/model", directory)).data;
  }

  async defaultModel(directory: string): Promise<RawModel | undefined> {
    return (await this.get<{ data: RawModel | null }>("/api/model/default", directory)).data ?? undefined;
  }

  async agents(directory: string): Promise<RawAgent[]> {
    return (await this.get<{ data: RawAgent[] }>("/api/agent", directory)).data;
  }

  /** opencode replaces `metadata` as a whole, so pass every key the session should keep. */
  updateSession(id: string, patch: { title?: string; metadata?: Record<string, unknown> }, directory?: string): Promise<void> {
    return this.send("PATCH", `/api/session/${encodeURIComponent(id)}`, patch, directory);
  }

  /** Deletes a session; opencode deletes its child (subagent) sessions with it. */
  deleteSession(id: string, directory?: string): Promise<void> {
    return this.send("DELETE", `/api/session/${encodeURIComponent(id)}`, undefined, directory);
  }

  info(): Promise<{ version: string }> {
    return this.get("/api/info");
  }

  async sessions(): Promise<RawSession[]> {
    return (await this.get<{ data: RawSession[] }>("/api/session")).data;
  }

  async session(id: string): Promise<RawSession> {
    return (await this.get<{ data: RawSession }>(`/api/session/${encodeURIComponent(id)}`)).data;
  }

  async active(): Promise<Set<string>> {
    const r = await this.get<{ data: Record<string, unknown> }>("/api/session/active");
    return new Set(Object.keys(r.data));
  }

  async permissionRequests(directory: string): Promise<RawPermissionRequest[]> {
    return (await this.get<{ data: RawPermissionRequest[] }>("/api/permission/request", directory)).data;
  }

  async forms(directory: string): Promise<RawForm[]> {
    return (await this.get<{ data: RawForm[] }>("/api/form", directory)).data;
  }

  /** Resolves when the stream ends; rejects on HTTP or network errors (including abort). */
  async subscribe(onEvent: (event: OpencodeEvent) => void, signal: AbortSignal): Promise<void> {
    const res = await this.fetchImpl(this.ep.baseUrl + "/api/event", {
      headers: { authorization: basicAuth(this.ep.password), accept: "text/event-stream" },
      signal,
    });
    if (!res.ok || !res.body) throw new OpencodeHttpError(res.status, "/api/event");
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = block
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          onEvent(JSON.parse(data) as OpencodeEvent);
        } catch {
          // ignore malformed event payloads
        }
      }
    }
  }
}
