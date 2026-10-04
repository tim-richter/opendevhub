import type { FormAnswer, FormField, PermissionDecision } from "../../shared/types";

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

export class OpencodeClient {
  constructor(
    private readonly ep: OpencodeEndpoint,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string, directory?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: basicAuth(this.ep.password), accept: "application/json" };
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchImpl(this.ep.baseUrl + path, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new OpencodeHttpError(res.status, path);
    return (await res.json()) as T;
  }

  /** Starts a session whose working directory is `directory` (the workspace or one of its worktrees). */
  async createSession(directory: string, title?: string): Promise<RawSession> {
    const path = "/api/session";
    const res = await this.fetchImpl(this.ep.baseUrl + path, {
      method: "POST",
      headers: {
        authorization: basicAuth(this.ep.password),
        accept: "application/json",
        "content-type": "application/json",
        "x-opencode-directory": directory,
      },
      body: JSON.stringify({ ...(title ? { title } : {}), location: { directory } }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new OpencodeHttpError(res.status, path);
    const body = (await res.json()) as { data?: RawSession } & Partial<RawSession>;
    // Accept both the `{ data }` envelope used by the list routes and a bare session.
    return (body.data ?? body) as RawSession;
  }

  private async send(method: "POST" | "DELETE", path: string, body?: unknown, directory?: string): Promise<void> {
    const headers: Record<string, string> = { authorization: basicAuth(this.ep.password), accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (directory) headers["x-opencode-directory"] = directory;
    const res = await this.fetchImpl(this.ep.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      await res.text().catch(() => "");
      return;
    }
    const err = (await res.json().catch(() => ({}))) as { _tag?: unknown; message?: unknown };
    throw new OpencodeHttpError(
      res.status,
      path,
      typeof err._tag === "string" ? err._tag : undefined,
      typeof err.message === "string" ? err.message : undefined,
    );
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
