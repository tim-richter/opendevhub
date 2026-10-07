import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OsSecretStore, type SecretStore } from "./secrets";
import type { ForgejoChecks, ForgejoComment, ForgejoConnection, ForgejoDiff, ForgejoPage, ForgejoPullDetails, ForgejoPullQuery, ForgejoPullRequest, ForgejoPulls, ForgejoReview, ForgejoSettings } from "../shared/forgejo";

export class ForgejoError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 412 | 502 = 400) {
    super(message);
    this.name = "ForgejoError";
  }
}

interface SavedSettings {
  enabled: boolean;
  url: string;
  tokenRef?: string;
  /** Read only for migrating the previous plaintext format. Never written. */
  token?: string;
}

class InvalidSavedSettingsError extends ForgejoError {}

/** HTTPS keeps the token confidential in transit; loopback HTTP is useful for local instances. */
export function forgejoUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new ForgejoError("Enter a valid Forgejo URL."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ForgejoError("Use HTTPS for Forgejo (HTTP is allowed only on loopback).");
  }
  if (url.username || url.password || url.search || url.hash || /%(?:2f|5c|2e)/i.test(url.pathname)) {
    throw new ForgejoError("The Forgejo URL must not contain credentials, a query, or a fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

/** The file holds only connection settings and an opaque reference into the OS credential store. */
export class FileForgejoSettings {
  private readonly dir: string;
  private readonly file: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(configDir: string, private readonly secrets: SecretStore = new OsSecretStore()) {
    this.dir = path.join(configDir, "integrations");
    this.file = path.join(this.dir, "forgejo.json");
  }

  /** Serialize migrations and edits so concurrent browser requests cannot lose a token. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.pending.then(fn);
    this.pending = result.then(() => {}, () => {});
    return result;
  }

  private record(): SavedSettings {
    let raw: string;
    try {
      fs.chmodSync(this.dir, 0o700);
      fs.chmodSync(this.file, 0o600);
      raw = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { enabled: false, url: "" };
      throw new ForgejoError("Could not read the saved Forgejo settings.", 502);
    }
    try {
      const value = JSON.parse(raw) as SavedSettings;
      if (!value || typeof value.enabled !== "boolean" || typeof value.url !== "string" ||
          (value.token !== undefined && (typeof value.token !== "string" || !value.token || /\s/.test(value.token))) ||
          (value.tokenRef !== undefined && (typeof value.tokenRef !== "string" || !/^[0-9a-f-]{36}$/.test(value.tokenRef))) ||
          (value.token && value.tokenRef)) throw new Error();
      return { enabled: value.enabled, url: value.url ? forgejoUrl(value.url) : "",
        ...(value.token ? { token: value.token } : {}), ...(value.tokenRef ? { tokenRef: value.tokenRef } : {}) };
    } catch {
      throw new InvalidSavedSettingsError("Saved Forgejo settings are invalid. Replace them in Settings.", 502);
    }
  }

  private write(value: SavedSettings): void {
    const tmp = path.join(this.dir, `${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.dir, 0o700);
      // Pick fields explicitly so even migration failures can never write plaintext credentials.
      const saved = { enabled: value.enabled, url: value.url, ...(value.tokenRef ? { tokenRef: value.tokenRef } : {}) };
      fs.writeFileSync(tmp, JSON.stringify(saved) + "\n", { mode: 0o600, flag: "wx" });
      fs.renameSync(tmp, this.file);
    } catch {
      throw new ForgejoError("Could not save Forgejo settings.", 502);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  private async migrate(value: SavedSettings): Promise<SavedSettings> {
    if (!value.token) return value;
    const tokenRef = randomUUID();
    await this.secrets.set(tokenRef, value.token);
    const migrated = { enabled: value.enabled, url: value.url, tokenRef };
    try { this.write(migrated); } catch (err) {
      await this.secrets.remove(tokenRef).catch(() => {});
      throw err;
    }
    return migrated;
  }

  read(): Promise<{ enabled: boolean; url: string; token?: string }> {
    return this.locked(async () => {
      const value = await this.migrate(this.record());
      const token = value.tokenRef ? await this.secrets.get(value.tokenRef) : undefined;
      return { enabled: value.enabled, url: value.url, ...(token ? { token } : {}) };
    });
  }

  view(): Promise<ForgejoSettings> {
    return this.locked(async () => {
      const value = await this.migrate(this.record());
      return { enabled: value.enabled, url: value.url, hasToken: !!value.tokenRef };
    });
  }

  save(input: Record<string, unknown>): Promise<ForgejoSettings> {
    return this.locked(async () => {
      if (typeof input.enabled !== "boolean" || typeof input.url !== "string" ||
          (input.token !== undefined && typeof input.token !== "string") ||
          (input.clearToken !== undefined && typeof input.clearToken !== "boolean")) {
        throw new ForgejoError("Invalid Forgejo settings.");
      }
      const url = input.url.trim() ? forgejoUrl(input.url) : "";
      const supplied = typeof input.token === "string" ? input.token.trim() : undefined;
      if (supplied && (/\s/.test(supplied) || supplied.length > 4096)) throw new ForgejoError("Invalid Forgejo token.");
      if (input.clearToken && supplied) throw new ForgejoError("Choose a new token or remove the saved token.");
      let old: SavedSettings;
      try { old = this.record(); } catch (err) {
        if (!(err instanceof InvalidSavedSettingsError)) throw err;
        old = { enabled: false, url: "" };
      }
      const keep = !input.clearToken && !supplied && old.url === url;
      if (input.enabled && (!url || (!supplied && !(keep && (old.tokenRef || old.token))))) {
        throw new ForgejoError("A Forgejo URL and token are required to enable Forgejo.");
      }
      if (keep) {
        const kept = await this.migrate(old);
        this.write({ enabled: input.enabled, url, tokenRef: kept.tokenRef });
        return { enabled: input.enabled, url, hasToken: !!kept.tokenRef };
      }
      const tokenRef = supplied ? randomUUID() : undefined;
      const previousToken = old.tokenRef ? await this.secrets.get(old.tokenRef) : undefined;
      if (tokenRef) await this.secrets.set(tokenRef, supplied!);
      let removedPrevious = false;
      try {
        // Removing/replacing a token must really delete the old credential; failures are reported.
        if (old.tokenRef) {
          await this.secrets.remove(old.tokenRef);
          removedPrevious = true;
        }
        this.write({ enabled: input.enabled, url, tokenRef });
      } catch (err) {
        if (removedPrevious && old.tokenRef && previousToken) await this.secrets.set(old.tokenRef, previousToken).catch(() => {});
        if (tokenRef) await this.secrets.remove(tokenRef).catch(() => {});
        throw err;
      }
      return { enabled: input.enabled, url, hasToken: !!tokenRef };
    });
  }
}

function segment(value: string): string {
  if (!value || value === "." || value === ".." || /[\\/\s\x00-\x1f]/.test(value)) throw new ForgejoError("Invalid Forgejo repository.");
  return encodeURIComponent(value);
}

interface Issue {
  number: number;
  title: string;
  updated_at: string;
  state: string;
  user: { login: string };
  repository: { full_name: string };
  pull_request?: { merged?: boolean } | null;
}

export class Forgejo {
  constructor(private readonly settings: FileForgejoSettings, private readonly fetcher: typeof fetch = fetch) {}

  view(): Promise<ForgejoSettings> { return this.settings.view(); }
  save(input: Record<string, unknown>): Promise<ForgejoSettings> { return this.settings.save(input); }

  private async connection(): Promise<{ enabled: boolean; url: string; token: string }> {
    if (!(await this.settings.view()).enabled) throw new ForgejoError("Enable Forgejo in Settings first.", 412);
    const settings = await this.settings.read();
    if (!settings.enabled || !settings.url) throw new ForgejoError("Enable Forgejo in Settings first.", 412);
    if (!settings.token) throw new ForgejoError("The saved Forgejo token is missing from the OS credential store. Enter a new token in Settings.", 412);
    return { ...settings, token: settings.token };
  }

  private async request(connection: SavedSettings & { token: string }, route: string, accept = "application/json", signal?: AbortSignal): Promise<string> {
    try {
      const response = await this.fetcher(`${connection.url}/api/v1/${route}`, {
        headers: { authorization: `token ${connection.token}`, accept },
        // Never forward the token to a redirect destination, including another path on this server.
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) throw new ForgejoError("Forgejo rejected the token. Check its permissions in Settings.", 502);
        if (response.status === 404) throw new ForgejoError("Forgejo could not find this pull request or API endpoint.", 404);
        if (response.status === 429) throw new ForgejoError("Forgejo's request limit was reached. Wait before refreshing.", 502);
        throw new ForgejoError(`Forgejo request failed (${response.status}).`, 502);
      }
      // Bound memory consumption even when a remote server omits Content-Length.
      const reader = response.body?.getReader();
      if (!reader) return "";
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 20 * 1024 * 1024) {
          await reader.cancel();
          throw new ForgejoError("The Forgejo response exceeds the 20 MiB display limit.", 502);
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } catch (err) {
      if (signal?.aborted) throw new ForgejoError("Forgejo request cancelled.", 502);
      if (err instanceof ForgejoError) throw err;
      // Fetch errors and upstream response bodies may contain credentials; keep them server-side.
      throw new ForgejoError("Could not reach Forgejo. Check the URL, connection, and TLS certificate.", 502);
    }
  }

  private async json<T>(connection: SavedSettings & { token: string }, route: string, signal?: AbortSignal): Promise<T> {
    const text = await this.request(connection, route, "application/json", signal);
    try { return JSON.parse(text) as T; } catch { throw new ForgejoError("Forgejo returned an invalid API response.", 502); }
  }

  private pull(connection: SavedSettings, owner: string, repo: string, value: { number: number; title: string; updated_at: string; state?: string; merged?: boolean; pull_request?: { merged?: boolean } | null }): ForgejoPullRequest {
    if (!value || !Number.isSafeInteger(value.number) || value.number <= 0 || typeof value.title !== "string" || typeof value.updated_at !== "string") {
      throw new ForgejoError("Forgejo returned an invalid pull request.", 502);
    }
    return {
      owner, repo, number: value.number, title: value.title, updatedAt: value.updated_at,
      state: value.merged || value.pull_request?.merged ? "merged" : value.state === "closed" ? "closed" : "open",
      url: `${connection.url}/${segment(owner)}/${segment(repo)}/pulls/${value.number}`,
    };
  }

  /** Test unsaved credentials without changing the stored connection. */
  async test(input: Record<string, unknown>, signal?: AbortSignal): Promise<ForgejoConnection> {
    if (typeof input.url !== "string" || (input.token !== undefined && typeof input.token !== "string")) throw new ForgejoError("Invalid Forgejo settings.");
    const url = forgejoUrl(input.url);
    let token = typeof input.token === "string" ? input.token.trim() : "";
    if (!token) {
      const saved = await this.settings.view();
      if (saved.url === url) token = (await this.settings.read()).token ?? "";
    }
    if (!token || /\s/.test(token) || token.length > 4096) throw new ForgejoError("Enter a token for this instance before testing the connection.");
    const connection = { enabled: true, url, token };
    const user = await this.json<{ login: string }>(connection, "user", signal);
    if (!user?.login || typeof user.login !== "string") throw new ForgejoError("Forgejo returned an invalid account.", 502);
    const version = await this.json<{ version: string }>(connection, "version", signal);
    if (typeof version?.version !== "string") throw new ForgejoError("Forgejo returned an invalid API version.", 502);
    // Verify the same read endpoints used by the dashboard, including repository access.
    const pulls = await this.json<unknown>(connection, "repos/issues/search?type=pulls&created=true&limit=1", signal);
    const repos = await this.json<unknown>(connection, "user/repos?limit=1", signal);
    if (!Array.isArray(pulls) || !Array.isArray(repos)) throw new ForgejoError("Forgejo returned an invalid read-access response.", 502);
    return { username: user.login, version: version.version };
  }

  async inbox(input: ForgejoPullQuery = {}, signal?: AbortSignal): Promise<ForgejoPulls> {
    const { state = "all", inbox = "authored", q = "", repository = "", page = 1 } = input;
    if (!["all", "open", "closed"].includes(state) || !["authored", "assigned", "review-requested"].includes(inbox) ||
        typeof q !== "string" || q.length > 200 || typeof repository !== "string" || !Number.isSafeInteger(page) || page < 1 || page > 200) throw new ForgejoError("Invalid pull request filters.");
    const parts = repository ? repository.split("/") : [];
    if (repository && parts.length !== 2) throw new ForgejoError("Enter a repository as owner/name.");
    parts.forEach(segment);
    const connection = await this.connection();
    const user = await this.json<{ login: string }>(connection, "user", signal);
    if (!user || typeof user.login !== "string" || !user.login) throw new ForgejoError("Forgejo returned an invalid account.", 502);
    const query = new URLSearchParams({ type: "pulls", state, page: String(page), limit: "50", sort: "recentupdate" });
    query.set(inbox === "authored" ? "created" : inbox === "assigned" ? "assigned" : "review_requested", "true");
    if (q.trim()) query.set("q", q.trim());
    // Forgejo search supports owner and priority_repo_id, not a repository-name filter.
    if (repository) {
      const repo = await this.json<{ id: number }>(connection, `repos/${segment(parts[0])}/${segment(parts[1])}`, signal);
      if (!Number.isSafeInteger(repo?.id) || repo.id < 1) throw new ForgejoError("Forgejo returned an invalid repository.", 502);
      query.set("owner", parts[0]);
      query.set("priority_repo_id", String(repo.id));
    }
    const issues = await this.json<Issue[]>(connection, `repos/issues/search?${query}`, signal);
    if (!Array.isArray(issues)) throw new ForgejoError("Forgejo returned an invalid pull request list.", 502);
    const pulls = new Map<string, ForgejoPullRequest>();
    for (const issue of issues) {
      if (!issue?.pull_request || (state !== "all" && issue.state !== state) || (inbox === "authored" && issue.user?.login !== user.login)) continue;
      const parts = issue.repository?.full_name?.split("/");
      if (!parts || parts.length !== 2) throw new ForgejoError("Forgejo returned an invalid repository.", 502);
      if (repository && issue.repository.full_name.toLowerCase() !== repository.toLowerCase()) continue;
      const pull = this.pull(connection, parts[0], parts[1], issue);
      pulls.set(`${pull.owner}/${pull.repo}/${pull.number}`, pull);
    }
    // Continue on nonempty pages: instance administrators can cap the requested page size.
    return { username: user.login, pulls: [...pulls.values()], ...(issues.length ? { nextPage: page + 1 } : {}) };
  }

  async pulls(state = "all"): Promise<ForgejoPulls> {
    if (!["all", "open", "closed"].includes(state)) throw new ForgejoError("Invalid pull request state.");
    const connection = await this.connection();
    const user = await this.json<{ login: string }>(connection, "user");
    if (!user || typeof user.login !== "string" || !user.login) throw new ForgejoError("Forgejo returned an invalid account.", 502);
    const pulls = new Map<string, ForgejoPullRequest>();
    for (let page = 1; page <= 200; page++) {
      const query = new URLSearchParams({ type: "pulls", state, created: "true", page: String(page), limit: "50", sort: "recentupdate" });
      const issues = await this.json<Issue[]>(connection, `repos/issues/search?${query}`);
      if (!Array.isArray(issues)) throw new ForgejoError("Forgejo returned an invalid pull request list.", 502);
      if (issues.length === 0) return { username: user.login, pulls: [...pulls.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
      for (const issue of issues) {
        // Also filter locally: older servers may ignore search filters.
        if (!issue?.pull_request || (state !== "all" && issue.state !== state) || issue.user?.login !== user.login) continue;
        const parts = issue.repository?.full_name?.split("/");
        if (!parts || parts.length !== 2) throw new ForgejoError("Forgejo returned an invalid repository.", 502);
        const pull = this.pull(connection, parts[0], parts[1], issue);
        pulls.set(`${pull.owner}/${pull.repo}/${pull.number}`, pull);
      }
    }
    throw new ForgejoError("Too many pull requests to load. Select a state filter or narrow the token's repository access.", 502);
  }

  private route(owner: string, repo: string, number: string): string {
    if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(Number(number))) throw new ForgejoError("Invalid pull request number.");
    return `repos/${segment(owner)}/${segment(repo)}/pulls/${number}`;
  }

  async details(owner: string, repo: string, number: string, signal?: AbortSignal): Promise<ForgejoPullDetails> {
    const route = this.route(owner, repo, number);
    const connection = await this.connection();
    const value = await this.json<{
      number: number; title: string; updated_at: string; state: string; merged: boolean; body?: string; user?: { login: string };
      base: { ref: string }; head: { ref: string; sha: string; repo?: { full_name: string } }; draft?: boolean; mergeable?: boolean;
      labels?: { name: string }[]; requested_reviewers?: { login: string }[];
    }>(connection, route, signal);
    const pull = this.pull(connection, owner, repo, value);
    if (value.number !== Number(number) || typeof value.base?.ref !== "string" || typeof value.head?.ref !== "string") throw new ForgejoError("Forgejo returned invalid pull request details.", 502);
    return { pull, body: value.body ?? "", author: value.user?.login ?? "", base: value.base.ref, head: value.head.ref,
      headSha: value.head.sha ?? "", headRepository: value.head.repo?.full_name, draft: !!value.draft, mergeable: value.mergeable,
      labels: (value.labels ?? []).map((l) => l.name), reviewers: (value.requested_reviewers ?? []).map((u) => u.login) };
  }

  async patch(owner: string, repo: string, number: string, signal?: AbortSignal): Promise<{ patch: string }> {
    const route = this.route(owner, repo, number);
    return { patch: await this.request(await this.connection(), `${route}.diff`, "text/plain", signal) };
  }

  private page(value: number): string {
    if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new ForgejoError("Invalid page.");
    return `page=${value}&limit=50`;
  }

  async comments(owner: string, repo: string, number: string, page = 1, signal?: AbortSignal): Promise<ForgejoPage<ForgejoComment>> {
    const route = this.route(owner, repo, number).replace("/pulls/", "/issues/");
    const values = await this.json<RawComment[]>(await this.connection(), `${route}/comments?${this.page(page)}`, signal);
    if (!Array.isArray(values)) throw new ForgejoError("Forgejo returned invalid comments.", 502);
    return { items: values.map(comment), ...(values.length ? { nextPage: page + 1 } : {}) };
  }

  async reviews(owner: string, repo: string, number: string, page = 1, signal?: AbortSignal): Promise<ForgejoPage<ForgejoReview>> {
    const route = this.route(owner, repo, number);
    const values = await this.json<{ id: number; user?: { login: string }; body: string; state: string; submitted_at: string;
      commit_id: string; dismissed: boolean; stale: boolean; comments_count: number }[]>(await this.connection(), `${route}/reviews?${this.page(page)}`, signal);
    if (!Array.isArray(values)) throw new ForgejoError("Forgejo returned invalid reviews.", 502);
    return { items: values.map((v) => ({ id: v.id, author: v.user?.login ?? "", body: v.body ?? "", state: v.state,
      submittedAt: v.submitted_at, commit: v.commit_id, dismissed: !!v.dismissed, stale: !!v.stale, commentsCount: v.comments_count ?? 0 })),
      ...(values.length ? { nextPage: page + 1 } : {}) };
  }

  async reviewComments(owner: string, repo: string, number: string, id: string, signal?: AbortSignal): Promise<ForgejoComment[]> {
    const route = this.route(owner, repo, number);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new ForgejoError("Invalid review.");
    const values = await this.json<RawComment[]>(await this.connection(), `${route}/reviews/${id}/comments`, signal);
    if (!Array.isArray(values)) throw new ForgejoError("Forgejo returned invalid review comments.", 502);
    return values.map(comment);
  }

  async checks(owner: string, repo: string, sha: string, page = 1, signal?: AbortSignal): Promise<ForgejoChecks> {
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) throw new ForgejoError("Invalid commit.");
    const value = await this.json<{ state: string; sha: string; total_count: number;
      statuses: { id: number; context: string; status: string; description: string; target_url?: string }[] }>(await this.connection(),
      `repos/${segment(owner)}/${segment(repo)}/commits/${sha}/status?${this.page(page)}`, signal);
    if (!value || !Array.isArray(value.statuses)) throw new ForgejoError("Forgejo returned invalid checks.", 502);
    return { state: value.state, sha: value.sha, items: value.statuses.map((s) => ({ id: s.id, name: s.context, status: s.status,
      description: s.description ?? "", url: safeWebUrl(s.target_url) })),
      ...(value.statuses.length && (page - 1) * value.statuses.length + value.statuses.length < value.total_count ? { nextPage: page + 1 } : {}) };
  }

  async diff(owner: string, repo: string, number: string): Promise<ForgejoDiff> {
    const details = await this.details(owner, repo, number);
    return { pull: details.pull, base: details.base, head: details.head, ...(await this.patch(owner, repo, number)) };
  }
}

interface RawComment { id: number; user?: { login: string }; body: string; updated_at: string; path?: string; position?: number;
  original_position?: number; diff_hunk?: string; resolver?: { login: string } | null }
function comment(v: RawComment): ForgejoComment {
  return { id: v.id, author: v.user?.login ?? "", body: v.body ?? "", updatedAt: v.updated_at, path: v.path,
    line: v.position, oldLine: v.original_position, diffHunk: v.diff_hunk, resolved: !!v.resolver };
}
function safeWebUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
}
