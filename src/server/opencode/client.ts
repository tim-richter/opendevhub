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
}

export interface RawForm {
  id: string;
  sessionID: string;
  title: string;
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
  ) {
    super(`opencode ${path} responded ${status}`);
    this.name = "OpencodeHttpError";
  }
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

  info(): Promise<{ version: string }> {
    return this.get("/api/info");
  }

  async sessions(): Promise<RawSession[]> {
    return (await this.get<{ data: RawSession[] }>("/api/session")).data;
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
