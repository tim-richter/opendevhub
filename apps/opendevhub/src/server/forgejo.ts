import { FileIntegrationSettings, IntegrationError, integrationUrl } from "./integration-settings";
import { OsSecretStore, type SecretStore } from "./secrets";
import type { ForgejoChecks, ForgejoComment, ForgejoConnection, ForgejoDiff, ForgejoPage, ForgejoPullDetails, ForgejoPullQuery, ForgejoPullRequest, ForgejoPulls, ForgejoReview, ForgejoSettings } from "../shared/forgejo";

export class ForgejoError extends IntegrationError {
  constructor(message: string, status: 400 | 404 | 412 | 502 = 400) { super(message, status); this.name = "ForgejoError"; }
}

export function forgejoUrl(raw: string): string { return integrationUrl(raw, "Forgejo", ForgejoError); }

export class FileForgejoSettings extends FileIntegrationSettings {
  constructor(configDir: string, secrets: SecretStore = new OsSecretStore()) {
    super(configDir, "Forgejo", forgejoUrl, ForgejoError, secrets);
  }
}

interface SavedSettings { enabled: boolean; url: string }

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

  private async request(connection: SavedSettings & { token: string }, route: string, accept = "application/json", signal?: AbortSignal, body?: unknown): Promise<string> {
    try {
      const response = await this.fetcher(`${connection.url}/api/v1/${route}`, {
        headers: { authorization: `token ${connection.token}`, accept, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
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
    if (!["all", "open", "closed"].includes(state) || !["authored", "assigned", "review-requested", "review"].includes(inbox) ||
        typeof q !== "string" || q.length > 200 || typeof repository !== "string" || !Number.isSafeInteger(page) || page < 1 || page > 200) throw new ForgejoError("Invalid pull request filters.");
    const parts = repository ? repository.split("/") : [];
    if (repository && parts.length !== 2) throw new ForgejoError("Enter a repository as owner/name.");
    parts.forEach(segment);
    const connection = await this.connection();
    const user = await this.json<{ login: string }>(connection, "user", signal);
    if (!user || typeof user.login !== "string" || !user.login) throw new ForgejoError("Forgejo returned an invalid account.", 502);
    const query = new URLSearchParams({ type: "pulls", state, page: String(page), limit: "50", sort: "recentupdate" });
    if (inbox !== "review") query.set(inbox === "authored" ? "created" : inbox === "assigned" ? "assigned" : "review_requested", "true");
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

  async pulls(state = "open", scope = "authored"): Promise<ForgejoPulls> {
    if (!["all", "open", "closed"].includes(state)) throw new ForgejoError("Invalid pull request state.");
    if (!["authored", "review"].includes(scope)) throw new ForgejoError("Invalid pull request scope.");
    if (scope === "review") state = "open";
    const connection = await this.connection();
    const user = await this.json<{ login: string }>(connection, "user");
    if (!user || typeof user.login !== "string" || !user.login) throw new ForgejoError("Forgejo returned an invalid account.", 502);
    const pulls = new Map<string, ForgejoPullRequest>();
    for (let page = 1; page <= 200; page++) {
      const query = new URLSearchParams({ type: "pulls", state, ...(scope === "authored" ? { created: "true" } : {}), page: String(page), limit: "50", sort: "recentupdate" });
      const issues = await this.json<Issue[]>(connection, `repos/issues/search?${query}`);
      if (!Array.isArray(issues)) throw new ForgejoError("Forgejo returned an invalid pull request list.", 502);
      if (issues.length === 0) return { username: user.login, pulls: [...pulls.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
      for (const issue of issues) {
        // Also filter locally: older servers may ignore search filters.
        if (!issue?.pull_request || (state !== "all" && issue.state !== state) || (scope === "authored" && issue.user?.login !== user.login)) continue;
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
      statuses: { id: number; context: string; status: string; description: string; target_url?: string }[] | null }>(await this.connection(),
      `repos/${segment(owner)}/${segment(repo)}/commits/${sha}/status?${this.page(page)}`, signal);
    // Forgejo serializes a commit without any statuses as `null`, not `[]`.
    const statuses = value?.statuses ?? [];
    if (!value || !Array.isArray(statuses)) throw new ForgejoError("Forgejo returned invalid checks.", 502);
    return { state: value.state, sha: value.sha, items: statuses.map((s) => ({ id: s.id, name: s.context, status: s.status,
      description: s.description ?? "", url: safeWebUrl(s.target_url) })),
      ...(statuses.length && (page - 1) * statuses.length + statuses.length < value.total_count ? { nextPage: page + 1 } : {}) };
  }

  async diff(owner: string, repo: string, number: string): Promise<ForgejoDiff> {
    const details = await this.details(owner, repo, number);
    return { pull: details.pull, base: details.base, head: details.head, commitId: details.headSha || undefined, ...(await this.patch(owner, repo, number)) };
  }
  async review(owner: string, repo: string, number: string, input: Record<string, unknown>): Promise<{ sent: true }> {
    if (typeof input.commitId !== "string" || !/^[0-9a-f]{40,64}$/i.test(input.commitId) ||
        typeof input.body !== "string" || input.body.length > 100_000 ||
        !["COMMENT", "APPROVED", "REQUEST_CHANGES"].includes(String(input.event)) ||
        !Array.isArray(input.comments) || input.comments.length > 200) throw new ForgejoError("Invalid review.");
    const comments = input.comments.map((c) => {
      if (!c || typeof c.path !== "string" || !c.path || typeof c.body !== "string" || !c.body.trim() || c.body.length > 100_000 ||
          !Number.isSafeInteger(c.old_position) || !Number.isSafeInteger(c.new_position) ||
          !((c.old_position > 0 && c.new_position === 0) || (c.new_position > 0 && c.old_position === 0))) throw new ForgejoError("Invalid review comment.");
      return { path: c.path, body: c.body, old_position: c.old_position, new_position: c.new_position };
    });
    if (input.event === "COMMENT" && !input.body.trim() && !comments.length) throw new ForgejoError("Add a comment before sending the review.");
    const diff = await this.diff(owner, repo, number);
    if (diff.pull.state !== "open") throw new ForgejoError("This pull request is no longer open.");
    if (diff.commitId !== input.commitId) throw new ForgejoError("The PR changed. Refresh its diff before sending a review.");
    await this.request(await this.connection(), `repos/${segment(owner)}/${segment(repo)}/pulls/${number}/reviews`, "application/json", undefined, {
      commit_id: input.commitId, body: input.body, event: input.event, comments,
    });
    return { sent: true };
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
