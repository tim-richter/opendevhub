import type {
  ForgejoApprovals,
  ForgejoChecks,
  ForgejoComment,
  ForgejoConnection,
  ForgejoDiff,
  ForgejoOrganizations,
  ForgejoPage,
  ForgejoPullDetails,
  ForgejoPullQuery,
  ForgejoPullRequest,
  ForgejoPulls,
  ForgejoPullStack,
  ForgejoReview,
  ForgejoSettings,
  ForgejoStackNode,
  ForgejoStackPull,
  ForgejoTeams,
} from "../../shared/forgejo";
import { imageType, MAX_IMAGE_BYTES } from "../../shared/images";
import type { ImageSide } from "../../shared/images";
import { OsSecretStore } from "./secrets";
import type { SecretStore } from "./secrets";
import {
  FileIntegrationSettings,
  IntegrationError,
  integrationUrl,
} from "./settings";

/** Forgejo's page size for the paged lists this client reads. */
const PAGE_SIZE = 50;
/** Upper bound on pages read for the organization and team pickers. */
const NAME_PAGES = 10;

/**
 * Each reviewer's latest approving or change-requesting review decides their vote, as Forgejo counts them: a
 * dismissed one no longer counts, and neither does one Forgejo doesn't consider official (e.g. from a reviewer
 * outside the approvals whitelist).
 */
export const countApprovals = (
  reviews: ForgejoReview[]
): Pick<ForgejoApprovals, "approvedBy" | "changesRequestedBy"> => {
  const latest = new Map<string, ForgejoReview>();
  for (const review of reviews.toSorted((a, b) => a.id - b.id)) {
    if (
      review.author &&
      (review.state === "APPROVED" || review.state === "REQUEST_CHANGES")
    ) {
      latest.set(review.author, review);
    }
  }
  const counted = [...latest.values()].filter(
    (r) => !r.dismissed && r.official !== false
  );
  return {
    approvedBy: counted
      .filter((r) => r.state === "APPROVED")
      .map((r) => r.author),
    changesRequestedBy: counted
      .filter((r) => r.state === "REQUEST_CHANGES")
      .map((r) => r.author),
  };
};

export class ForgejoError extends IntegrationError {
  constructor(message: string, status: 400 | 404 | 412 | 502 = 400) {
    super(message, status);
    this.name = "ForgejoError";
  }
}

export const forgejoUrl = (raw: string): string =>
  integrationUrl(raw, "Forgejo", ForgejoError);

export class FileForgejoSettings extends FileIntegrationSettings {
  constructor(configDir: string, secrets: SecretStore = new OsSecretStore()) {
    super(configDir, "Forgejo", forgejoUrl, ForgejoError, secrets);
  }
}

interface SavedSettings {
  enabled: boolean;
  url: string;
}

const segment = (value: string): string => {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    /[\\/\s\u0000-\u001F]/u.test(value)
  ) {
    throw new ForgejoError("Invalid Forgejo repository.");
  }
  return encodeURIComponent(value);
};

interface Issue {
  number: number;
  title: string;
  updated_at: string;
  state: string;
  user: { login: string };
  repository: { full_name: string };
  pull_request?: { merged?: boolean } | null;
}

interface RepoPull {
  number: number;
  title: string;
  base: {
    ref: string;
    repo_id: number;
    repo?: { default_branch?: string } | null;
  };
  head: { ref: string; repo_id: number };
}

/** Pages of a repository's open pull requests read to find stacks. */
const STACK_PAGES = 4;

/** The open pull request whose head branch in this repository is `base`; a fork's same-named branch doesn't count. */
const stackParent = (
  open: RepoPull[],
  base: string,
  skip: (number: number) => boolean
): RepoPull | undefined =>
  open.find(
    (p) =>
      !skip(p.number) &&
      p.head.ref === base &&
      p.head.repo_id === p.base.repo_id
  );

const stackPull = (p: RepoPull): ForgejoStackPull => ({
  base: p.base.ref,
  head: p.head.ref,
  number: p.number,
  title: p.title,
});

/** The open pull requests a pull request builds on and those built on it; undefined when there are none. */
const pullStack = (
  open: RepoPull[],
  current: { number: number; base: string; head?: string }
): ForgejoPullStack | undefined => {
  // Shared across both directions so branches that target each other in a loop end the walk.
  const seen = new Set([current.number]);
  const ancestors: ForgejoStackPull[] = [];
  for (
    let parent = stackParent(open, current.base, (n) => seen.has(n));
    parent;
    parent = stackParent(open, parent.base.ref, (n) => seen.has(n))
  ) {
    seen.add(parent.number);
    ancestors.unshift(stackPull(parent));
  }
  const children = (head: string): ForgejoStackNode[] => {
    const direct = open.filter(
      (p) => !seen.has(p.number) && p.base.ref === head
    );
    for (const p of direct) {
      seen.add(p.number);
    }
    return direct.map((p) => ({
      ...stackPull(p),
      // Nothing in this repository can target a fork's branch.
      children: p.head.repo_id === p.base.repo_id ? children(p.head.ref) : [],
    }));
  };
  const descendants = current.head ? children(current.head) : [];
  return ancestors.length || descendants.length
    ? { ancestors, descendants }
    : undefined;
};

/** How long a base branch's required approvals are reused; protection rules rarely change. */
const PROTECTION_TTL_MS = 5 * 60_000;

/** How long a repository's open pull requests are reused to find stacks; the inbox refetches on every focus. */
const STACK_TTL_MS = 60_000;

export class Forgejo {
  /** Required approvals per instance, repository and branch, shared by every pull request into that branch. */
  private readonly protection = new Map<
    string,
    { at: number; required: Promise<number | undefined> }
  >();
  /** Open pull requests per instance and repository, shared by inbox loads in quick succession. */
  private readonly openPullLists = new Map<
    string,
    { at: number; pulls: Promise<RepoPull[]> }
  >();

  private readonly settings: FileForgejoSettings;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  constructor(
    settings: FileForgejoSettings,
    fetcher: typeof fetch = fetch,
    now: () => number = Date.now
  ) {
    this.settings = settings;
    this.fetcher = fetcher;
    this.now = now;
  }

  view(): Promise<ForgejoSettings> {
    return this.settings.view();
  }
  save(input: Record<string, unknown>): Promise<ForgejoSettings> {
    // A different instance or token may see different protection rules and repositories.
    this.protection.clear();
    this.openPullLists.clear();
    return this.settings.save(input);
  }

  private async connection(): Promise<{
    enabled: boolean;
    url: string;
    token: string;
  }> {
    const result = await this.settings.view();
    if (!result.enabled) {
      throw new ForgejoError("Enable Forgejo in Settings first.", 412);
    }
    const settings = await this.settings.read();
    if (!settings.enabled || !settings.url) {
      throw new ForgejoError("Enable Forgejo in Settings first.", 412);
    }
    if (!settings.token) {
      throw new ForgejoError(
        "The saved Forgejo token is missing from the OS credential store. Enter a new token in Settings.",
        412
      );
    }
    return { ...settings, token: settings.token };
  }

  private async request(
    connection: SavedSettings & { token: string },
    route: string,
    accept = "application/json",
    signal?: AbortSignal,
    body?: unknown
  ): Promise<string> {
    const bytes = await this.requestBytes(
      connection,
      route,
      accept,
      signal,
      body
    );
    return bytes.toString("utf-8");
  }

  private async requestBytes(
    connection: SavedSettings & { token: string },
    route: string,
    accept: string,
    signal?: AbortSignal,
    body?: unknown,
    maxBytes = 20 * 1024 * 1024
  ): Promise<Buffer> {
    try {
      const response = await this.fetcher(`${connection.url}/api/v1/${route}`, {
        headers: {
          accept,
          authorization: `token ${connection.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body), method: "POST" } : {}),
        // Never forward the token to a redirect destination, including another path on this server.
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401 || response.status === 403) {
          throw new ForgejoError(
            "Forgejo rejected the token. Check its permissions in Settings.",
            502
          );
        }
        if (response.status === 404) {
          throw new ForgejoError(
            "Forgejo could not find this pull request or API endpoint.",
            404
          );
        }
        if (response.status === 429) {
          throw new ForgejoError(
            "Forgejo's request limit was reached. Wait before refreshing.",
            502
          );
        }
        throw new ForgejoError(
          `Forgejo request failed (${response.status}).`,
          502
        );
      }
      // Bound memory consumption even when a remote server omits Content-Length.
      const reader = response.body?.getReader();
      if (!reader) {
        return Buffer.alloc(0);
      }
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new ForgejoError(
            `The Forgejo response exceeds the ${maxBytes / 1024 / 1024} MiB display limit.`,
            502
          );
        }
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } catch (error) {
      if (signal?.aborted) {
        throw new ForgejoError("Forgejo request cancelled.", 502);
      }
      if (error instanceof ForgejoError) {
        throw error;
      }
      // Fetch errors and upstream response bodies may contain credentials; keep them server-side.
      throw new ForgejoError(
        "Could not reach Forgejo. Check the URL, connection, and TLS certificate.",
        502
      );
    }
  }

  private async json<T>(
    connection: SavedSettings & { token: string },
    route: string,
    signal?: AbortSignal
  ): Promise<T> {
    const text = await this.request(
      connection,
      route,
      "application/json",
      signal
    );
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ForgejoError("Forgejo returned an invalid API response.", 502);
    }
  }

  private pull(
    connection: SavedSettings,
    owner: string,
    repo: string,
    value: {
      number: number;
      title: string;
      updated_at: string;
      state?: string;
      merged?: boolean;
      pull_request?: { merged?: boolean } | null;
    }
  ): ForgejoPullRequest {
    if (
      !value ||
      !Number.isSafeInteger(value.number) ||
      value.number <= 0 ||
      typeof value.title !== "string" ||
      typeof value.updated_at !== "string"
    ) {
      throw new ForgejoError("Forgejo returned an invalid pull request.", 502);
    }
    let pullState: "merged" | "closed" | "open" = "open";
    if (value.merged || value.pull_request?.merged) {
      pullState = "merged";
    } else if (value.state === "closed") {
      pullState = "closed";
    }
    return {
      number: value.number,
      owner,
      repo,
      state: pullState,
      title: value.title,
      updatedAt: value.updated_at,
      url: `${connection.url}/${segment(owner)}/${segment(repo)}/pulls/${value.number}`,
    };
  }

  /** Test unsaved credentials without changing the stored connection. */
  async test(
    input: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<ForgejoConnection> {
    if (
      typeof input.url !== "string" ||
      (input.token !== undefined && typeof input.token !== "string")
    ) {
      throw new ForgejoError("Invalid Forgejo settings.");
    }
    const url = forgejoUrl(input.url);
    let token = typeof input.token === "string" ? input.token.trim() : "";
    if (!token) {
      const saved = await this.settings.view();
      if (saved.url === url) {
        const result2 = await this.settings.read();
        token = result2.token ?? "";
      }
    }
    if (!token || /\s/u.test(token) || token.length > 4096) {
      throw new ForgejoError(
        "Enter a token for this instance before testing the connection."
      );
    }
    const connection = { enabled: true, token, url };
    const user = await this.json<{ login: string }>(connection, "user", signal);
    if (!user?.login || typeof user.login !== "string") {
      throw new ForgejoError("Forgejo returned an invalid account.", 502);
    }
    const version = await this.json<{ version: string }>(
      connection,
      "version",
      signal
    );
    if (typeof version?.version !== "string") {
      throw new ForgejoError("Forgejo returned an invalid API version.", 502);
    }
    // Verify the same read endpoints used by the dashboard, including repository access.
    const pulls = await this.json<unknown>(
      connection,
      "repos/issues/search?type=pulls&created=true&limit=1",
      signal
    );
    const repos = await this.json<unknown>(
      connection,
      "user/repos?limit=1",
      signal
    );
    if (!Array.isArray(pulls) || !Array.isArray(repos)) {
      throw new ForgejoError(
        "Forgejo returned an invalid read-access response.",
        502
      );
    }
    return { username: user.login, version: version.version };
  }

  async inbox(
    input: ForgejoPullQuery = {},
    signal?: AbortSignal
  ): Promise<ForgejoPulls> {
    const {
      state = "all",
      inbox = "authored",
      q = "",
      repository = "",
      org = "",
      team = "",
      page = 1,
    } = input;
    if (
      !["all", "open", "closed"].includes(state) ||
      !["authored", "assigned", "review-requested", "review"].includes(inbox) ||
      typeof q !== "string" ||
      q.length > 200 ||
      typeof repository !== "string" ||
      typeof org !== "string" ||
      typeof team !== "string" ||
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 200
    ) {
      throw new ForgejoError("Invalid pull request filters.");
    }
    const parts = repository ? repository.split("/") : [];
    if (repository && parts.length !== 2) {
      throw new ForgejoError("Enter a repository as owner/name.");
    }
    for (const part of [
      ...parts,
      ...(org ? [org] : []),
      ...(team ? [team] : []),
    ]) {
      segment(part);
    }
    if (team && !org) {
      throw new ForgejoError("Select an organization to filter by team.");
    }
    if (org && repository && parts[0].toLowerCase() !== org.toLowerCase()) {
      throw new ForgejoError(
        `The repository ${repository} is not in the organization ${org}.`
      );
    }
    const connection = await this.connection();
    const user = await this.json<{ login: string }>(connection, "user", signal);
    if (!user || typeof user.login !== "string" || !user.login) {
      throw new ForgejoError("Forgejo returned an invalid account.", 502);
    }
    const query = new URLSearchParams({
      limit: "50",
      page: String(page),
      sort: "recentupdate",
      state,
      type: "pulls",
    });
    if (inbox !== "review") {
      let param = "review_requested";
      if (inbox === "authored") {
        param = "created";
      } else if (inbox === "assigned") {
        param = "assigned";
      }
      query.set(param, "true");
    }
    if (q.trim()) {
      query.set("q", q.trim());
    }
    // Forgejo search supports owner and priority_repo_id, not a repository-name filter.
    if (repository) {
      const repo = await this.json<{ id: number }>(
        connection,
        `repos/${segment(parts[0])}/${segment(parts[1])}`,
        signal
      );
      if (!Number.isSafeInteger(repo?.id) || repo.id < 1) {
        throw new ForgejoError("Forgejo returned an invalid repository.", 502);
      }
      query.set("owner", parts[0]);
      query.set("priority_repo_id", String(repo.id));
    }
    if (org) {
      query.set("owner", org);
    }
    // Forgejo resolves the team within the owner organization and limits results to the team's repositories.
    if (team) {
      query.set("team", team);
    }
    const issues = await this.json<Issue[]>(
      connection,
      `repos/issues/search?${query}`,
      signal
    );
    if (!Array.isArray(issues)) {
      throw new ForgejoError(
        "Forgejo returned an invalid pull request list.",
        502
      );
    }
    const pulls = new Map<string, ForgejoPullRequest>();
    for (const issue of issues) {
      if (
        !issue?.pull_request ||
        (state !== "all" && issue.state !== state) ||
        (inbox === "authored" && issue.user?.login !== user.login)
      ) {
        continue;
      }
      const issueParts = issue.repository?.full_name?.split("/");
      if (!issueParts || issueParts.length !== 2) {
        throw new ForgejoError("Forgejo returned an invalid repository.", 502);
      }
      if (
        (repository &&
          issue.repository.full_name.toLowerCase() !==
            repository.toLowerCase()) ||
        (org && issueParts[0].toLowerCase() !== org.toLowerCase())
      ) {
        continue;
      }
      const pull = this.pull(connection, issueParts[0], issueParts[1], issue);
      pulls.set(`${pull.owner}/${pull.repo}/${pull.number}`, pull);
    }
    await this.addStacks(connection, [...pulls.values()]);
    // Continue on nonempty pages: instance administrators can cap the requested page size.
    return {
      pulls: [...pulls.values()],
      username: user.login,
      ...(issues.length ? { nextPage: page + 1 } : {}),
    };
  }

  /** Organizations the token's user belongs to, for the inbox's organization filter. */
  async organizations(signal?: AbortSignal): Promise<ForgejoOrganizations> {
    const connection = await this.connection();
    const orgs = await this.names(connection, "user/orgs", "username", signal);
    return { orgs };
  }

  /** Teams of an organization visible to the token's user, for the inbox's team filter. */
  async teams(org: string, signal?: AbortSignal): Promise<ForgejoTeams> {
    const connection = await this.connection();
    const teams = await this.names(
      connection,
      `orgs/${segment(org)}/teams`,
      "name",
      signal
    );
    return { teams };
  }

  private async names(
    connection: SavedSettings & { token: string },
    route: string,
    field: "name" | "username",
    signal?: AbortSignal
  ): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; page <= NAME_PAGES; page += 1) {
      const items = await this.json<Record<string, unknown>[]>(
        connection,
        `${route}?page=${page}&limit=${PAGE_SIZE}`,
        signal
      );
      if (!Array.isArray(items)) {
        throw new ForgejoError("Forgejo returned an invalid list.", 502);
      }
      for (const item of items) {
        const name = item?.[field];
        if (typeof name === "string" && name) {
          names.push(name);
        }
      }
      if (items.length < PAGE_SIZE) {
        break;
      }
    }
    return names.toSorted((a, b) => a.localeCompare(b));
  }

  /**
   * Marks open pull requests that target another branch than the default and links each to the open pull request
   * whose head is its base. One listing per repository; stacks are a hint, so a failed listing leaves them out.
   */
  private async addStacks(
    connection: SavedSettings & { token: string },
    pulls: ForgejoPullRequest[]
  ): Promise<void> {
    const byRepo = new Map<string, ForgejoPullRequest[]>();
    for (const pull of pulls) {
      if (pull.state === "open") {
        const key = `${pull.owner}/${pull.repo}`;
        const group = byRepo.get(key) ?? [];
        group.push(pull);
        byRepo.set(key, group);
      }
    }
    await Promise.all(
      [...byRepo.values()].map(async (repoPulls) => {
        const [{ owner, repo }] = repoPulls;
        let open: RepoPull[];
        try {
          open = await this.openPulls(connection, owner, repo);
        } catch {
          return;
        }
        const byNumber = new Map(open.map((p) => [p.number, p]));
        for (const pull of repoPulls) {
          const listed = byNumber.get(pull.number);
          if (!listed) {
            continue;
          }
          const base = listed.base.ref;
          const parent = stackParent(open, base, (n) => n === pull.number);
          const defaultBranch = listed.base.repo?.default_branch;
          if (parent || (defaultBranch && base !== defaultBranch)) {
            pull.stack = {
              base,
              ...(parent
                ? { parent: { number: parent.number, title: parent.title } }
                : {}),
            };
          }
        }
      })
    );
  }

  /**
   * A repository's open pull requests, cached briefly; concurrent loads share one listing. The shared listing
   * isn't tied to any caller's abort signal; it still times out.
   */
  private openPulls(
    connection: SavedSettings & { token: string },
    owner: string,
    repo: string
  ): Promise<RepoPull[]> {
    const key = `${connection.url}\n${segment(owner)}/${segment(repo)}`;
    const now = this.now();
    const cached = this.openPullLists.get(key);
    if (cached && now - cached.at < STACK_TTL_MS) {
      return cached.pulls;
    }
    // Drop expired listings so repositories that leave the inbox don't stay in memory.
    for (const [stale, entry] of this.openPullLists) {
      if (now - entry.at >= STACK_TTL_MS) {
        this.openPullLists.delete(stale);
      }
    }
    const pulls = this.listOpenPulls(connection, owner, repo);
    this.openPullLists.set(key, { at: now, pulls });
    // Failures aren't cached: the next inbox load tries again.
    pulls.catch(() => {
      if (this.openPullLists.get(key)?.pulls === pulls) {
        this.openPullLists.delete(key);
      }
    });
    return pulls;
  }

  private async listOpenPulls(
    connection: SavedSettings & { token: string },
    owner: string,
    repo: string
  ): Promise<RepoPull[]> {
    const open: RepoPull[] = [];
    for (let page = 1; page <= STACK_PAGES; page += 1) {
      const items = await this.json<RepoPull[]>(
        connection,
        `repos/${segment(owner)}/${segment(repo)}/pulls?state=open&page=${page}&limit=${PAGE_SIZE}`
      );
      if (!Array.isArray(items)) {
        throw new ForgejoError(
          "Forgejo returned an invalid pull request list.",
          502
        );
      }
      open.push(
        ...items.filter(
          (p) =>
            Number.isSafeInteger(p?.number) &&
            typeof p.title === "string" &&
            typeof p.base?.ref === "string" &&
            typeof p.head?.ref === "string"
        )
      );
      if (items.length < PAGE_SIZE) {
        break;
      }
    }
    return open;
  }

  async pulls(state = "open", scope = "authored"): Promise<ForgejoPulls> {
    if (!["all", "open", "closed"].includes(state)) {
      throw new ForgejoError("Invalid pull request state.");
    }
    if (!["authored", "review"].includes(scope)) {
      throw new ForgejoError("Invalid pull request scope.");
    }
    if (scope === "review") {
      state = "open";
    }
    const connection = await this.connection();
    const user = await this.json<{ login: string }>(connection, "user");
    if (!user || typeof user.login !== "string" || !user.login) {
      throw new ForgejoError("Forgejo returned an invalid account.", 502);
    }
    const pulls = new Map<string, ForgejoPullRequest>();
    for (let page = 1; page <= 200; page += 1) {
      const query = new URLSearchParams({
        type: "pulls",
        state,
        ...(scope === "authored" ? { created: "true" } : {}),
        page: String(page),
        limit: "50",
        sort: "recentupdate",
      });
      const issues = await this.json<Issue[]>(
        connection,
        `repos/issues/search?${query}`
      );
      if (!Array.isArray(issues)) {
        throw new ForgejoError(
          "Forgejo returned an invalid pull request list.",
          502
        );
      }
      if (issues.length === 0) {
        return {
          pulls: [...pulls.values()].toSorted((a, b) =>
            b.updatedAt.localeCompare(a.updatedAt)
          ),
          username: user.login,
        };
      }
      for (const issue of issues) {
        // Also filter locally: older servers may ignore search filters.
        if (
          !issue?.pull_request ||
          (state !== "all" && issue.state !== state) ||
          (scope === "authored" && issue.user?.login !== user.login)
        ) {
          continue;
        }
        const parts = issue.repository?.full_name?.split("/");
        if (!parts || parts.length !== 2) {
          throw new ForgejoError(
            "Forgejo returned an invalid repository.",
            502
          );
        }
        const pull = this.pull(connection, parts[0], parts[1], issue);
        pulls.set(`${pull.owner}/${pull.repo}/${pull.number}`, pull);
      }
    }
    throw new ForgejoError(
      "Too many pull requests to load. Select a state filter or narrow the token's repository access.",
      502
    );
  }

  private route(owner: string, repo: string, number: string): string {
    if (!/^[1-9]\d*$/u.test(number) || !Number.isSafeInteger(Number(number))) {
      throw new ForgejoError("Invalid pull request number.");
    }
    return `repos/${segment(owner)}/${segment(repo)}/pulls/${number}`;
  }

  /** A pull request's details with the stack it belongs to. */
  async details(
    owner: string,
    repo: string,
    number: string,
    signal?: AbortSignal
  ): Promise<ForgejoPullDetails> {
    const connection = await this.connection();
    const details = this.pullDetails(connection, owner, repo, number, signal);
    // Stacks are a hint: list the repository alongside the details and leave them out if that fails.
    const open = this.openPulls(connection, owner, repo).catch(() => []);
    const result = await details;
    const stack = pullStack(await open, {
      base: result.base,
      number: result.pull.number,
      // Only a head branch in this repository can be another pull request's base.
      ...(result.headRepository?.toLowerCase() ===
      `${owner}/${repo}`.toLowerCase()
        ? { head: result.head }
        : {}),
    });
    return stack ? { ...result, stack } : result;
  }

  private async pullDetails(
    connection: SavedSettings & { token: string },
    owner: string,
    repo: string,
    number: string,
    signal?: AbortSignal
  ): Promise<ForgejoPullDetails> {
    const route = this.route(owner, repo, number);
    const value = await this.json<{
      number: number;
      title: string;
      updated_at: string;
      state: string;
      merged: boolean;
      body?: string;
      user?: { login: string };
      base: { ref: string };
      head: { ref: string; sha: string; repo?: { full_name: string } };
      draft?: boolean;
      mergeable?: boolean;
      labels?: { name: string }[];
      requested_reviewers?: { login: string }[];
    }>(connection, route, signal);
    const pull = this.pull(connection, owner, repo, value);
    if (
      value.number !== Number(number) ||
      typeof value.base?.ref !== "string" ||
      typeof value.head?.ref !== "string"
    ) {
      throw new ForgejoError(
        "Forgejo returned invalid pull request details.",
        502
      );
    }
    return {
      author: value.user?.login ?? "",
      base: value.base.ref,
      body: value.body ?? "",
      draft: !!value.draft,
      head: value.head.ref,
      headRepository: value.head.repo?.full_name,
      headSha: value.head.sha ?? "",
      labels: (value.labels ?? []).map((l) => l.name),
      mergeable: value.mergeable,
      pull,
      reviewers: (value.requested_reviewers ?? []).map((u) => u.login),
    };
  }

  async patch(
    owner: string,
    repo: string,
    number: string,
    signal?: AbortSignal
  ): Promise<{ patch: string }> {
    const route = this.route(owner, repo, number);
    return {
      patch: await this.request(
        await this.connection(),
        `${route}.diff`,
        "text/plain",
        signal
      ),
    };
  }

  /**
   * One version of an image a pull request changes (Git LFS resolved): `old` at the merge-base in the base repository, `new` at the
   * head commit in the head repository (a fork's, maybe). Undefined where that version doesn't exist.
   */
  async image(
    owner: string,
    repo: string,
    number: string,
    file: string,
    side: ImageSide,
    signal?: AbortSignal
  ): Promise<{ bytes: Buffer; type: string } | undefined> {
    const type = imageType(file);
    const parts = file.split("/");
    if (
      !type ||
      parts.some(
        (p) => !p || p === "." || p === ".." || /[\u0000-\u001F]/u.test(p)
      )
    ) {
      throw new ForgejoError("Not an image in the pull request.");
    }
    const connection = await this.connection();
    const value = await this.json<{
      merge_base?: string;
      base?: { sha?: string };
      head?: { sha?: string; repo?: { full_name?: string } };
    }>(connection, this.route(owner, repo, number), signal);
    const [headOwner, headRepo] = value.head?.repo?.full_name?.split("/") ?? [
      owner,
      repo,
    ];
    const at =
      side === "old"
        ? { owner, ref: value.merge_base ?? value.base?.sha, repo }
        : { owner: headOwner, ref: value.head?.sha, repo: headRepo };
    if (!at.ref || !/^[0-9a-f]{7,64}$/u.test(at.ref)) {
      return undefined;
    }
    try {
      const bytes = await this.requestBytes(
        connection,
        `repos/${segment(at.owner)}/${segment(at.repo ?? "")}/media/${parts.map(encodeURIComponent).join("/")}?ref=${at.ref}`,
        "application/octet-stream",
        signal,
        undefined,
        MAX_IMAGE_BYTES
      );
      return { bytes, type };
    } catch (error) {
      if (error instanceof ForgejoError && error.status === 404) {
        return undefined;
      }
      throw error;
    }
  }

  private page(value: number): string {
    if (!Number.isSafeInteger(value) || value < 1 || value > 200) {
      throw new ForgejoError("Invalid page.");
    }
    return `page=${value}&limit=${PAGE_SIZE}`;
  }

  async comments(
    owner: string,
    repo: string,
    number: string,
    page = 1,
    signal?: AbortSignal
  ): Promise<ForgejoPage<ForgejoComment>> {
    const route = this.route(owner, repo, number).replace(
      "/pulls/",
      "/issues/"
    );
    const values = await this.json<RawComment[]>(
      await this.connection(),
      `${route}/comments?${this.page(page)}`,
      signal
    );
    if (!Array.isArray(values)) {
      throw new ForgejoError("Forgejo returned invalid comments.", 502);
    }
    return {
      items: values.map(comment),
      ...(values.length ? { nextPage: page + 1 } : {}),
    };
  }

  async reviews(
    owner: string,
    repo: string,
    number: string,
    page = 1,
    signal?: AbortSignal
  ): Promise<ForgejoPage<ForgejoReview>> {
    const route = this.route(owner, repo, number);
    const values = await this.json<
      {
        id: number;
        user?: { login: string };
        body: string;
        state: string;
        submitted_at: string;
        commit_id: string;
        dismissed: boolean;
        stale: boolean;
        comments_count: number;
        official?: boolean;
      }[]
    >(await this.connection(), `${route}/reviews?${this.page(page)}`, signal);
    if (!Array.isArray(values)) {
      throw new ForgejoError("Forgejo returned invalid reviews.", 502);
    }
    return {
      items: values.map((v) => ({
        author: v.user?.login ?? "",
        body: v.body ?? "",
        commentsCount: v.comments_count ?? 0,
        commit: v.commit_id,
        dismissed: !!v.dismissed,
        id: v.id,
        ...(typeof v.official === "boolean" ? { official: v.official } : {}),
        stale: !!v.stale,
        state: v.state,
        submittedAt: v.submitted_at,
      })),
      ...(values.length ? { nextPage: page + 1 } : {}),
    };
  }

  /** The base branch's required approvals and the reviewers who currently approve or request changes. */
  async approvals(
    owner: string,
    repo: string,
    number: string,
    signal?: AbortSignal
  ): Promise<ForgejoApprovals> {
    const details = await this.pullDetails(
      await this.connection(),
      owner,
      repo,
      number,
      signal
    );
    const required = await this.requiredApprovals(owner, repo, details.base);
    const reviews: ForgejoReview[] = [];
    // A short page is the last one; the cap bounds a pull request with an unusual number of reviews.
    for (let page = 1; page <= 20; page += 1) {
      const { items } = await this.reviews(owner, repo, number, page, signal);
      reviews.push(...items);
      if (items.length < PAGE_SIZE) {
        break;
      }
    }
    return { ...countApprovals(reviews), base: details.base, required };
  }

  /**
   * The approvals a branch's protection requires, or undefined when it has none. Cached for a few minutes, and
   * concurrent lookups share one request, so a list of pull requests asks once per repository and branch. The
   * shared request isn't tied to any caller's abort signal; it still times out.
   */
  private async requiredApprovals(
    owner: string,
    repo: string,
    base: string
  ): Promise<number | undefined> {
    const connection = await this.connection();
    const route = `repos/${segment(owner)}/${segment(repo)}/branches/${base
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    const key = `${connection.url}\n${route}`;
    const cached = this.protection.get(key);
    if (cached && this.now() - cached.at < PROTECTION_TTL_MS) {
      return cached.required;
    }
    const required = this.json<{
      protected?: boolean;
      required_approvals?: number;
    }>(connection, route).then(
      (value) =>
        value.protected ? (value.required_approvals ?? 0) : undefined,
      (error: unknown) => {
        // A deleted base branch has no protection left to satisfy.
        if (error instanceof ForgejoError && error.status === 404) {
          return undefined;
        }
        throw error;
      }
    );
    this.protection.set(key, { at: this.now(), required });
    // Failures aren't cached: the next pull request tries again.
    required.catch(() => {
      if (this.protection.get(key)?.required === required) {
        this.protection.delete(key);
      }
    });
    return required;
  }

  async reviewComments(
    owner: string,
    repo: string,
    number: string,
    id: string,
    signal?: AbortSignal
  ): Promise<ForgejoComment[]> {
    const route = this.route(owner, repo, number);
    if (!/^[1-9]\d*$/u.test(id) || !Number.isSafeInteger(Number(id))) {
      throw new ForgejoError("Invalid review.");
    }
    const values = await this.json<RawComment[]>(
      await this.connection(),
      `${route}/reviews/${id}/comments`,
      signal
    );
    if (!Array.isArray(values)) {
      throw new ForgejoError("Forgejo returned invalid review comments.", 502);
    }
    return values.map(comment);
  }

  async checks(
    owner: string,
    repo: string,
    sha: string,
    page = 1,
    signal?: AbortSignal
  ): Promise<ForgejoChecks> {
    if (!/^[a-f0-9]{40,64}$/iu.test(sha)) {
      throw new ForgejoError("Invalid commit.");
    }
    const value = await this.json<{
      state: string;
      sha: string;
      total_count: number;
      statuses:
        | {
            id: number;
            context: string;
            status: string;
            description: string;
            target_url?: string;
          }[]
        | null;
    }>(
      await this.connection(),
      `repos/${segment(owner)}/${segment(repo)}/commits/${sha}/status?${this.page(page)}`,
      signal
    );
    // Forgejo serializes a commit without any statuses as `null`, not `[]`.
    const statuses = value?.statuses ?? [];
    if (!value || !Array.isArray(statuses)) {
      throw new ForgejoError("Forgejo returned invalid checks.", 502);
    }
    return {
      items: statuses.map((s) => ({
        description: s.description ?? "",
        id: s.id,
        name: s.context,
        status: s.status,
        url: safeWebUrl(s.target_url),
      })),
      sha: value.sha,
      state: value.state,
      ...(statuses.length &&
      (page - 1) * statuses.length + statuses.length < value.total_count
        ? { nextPage: page + 1 }
        : {}),
    };
  }

  async diff(
    owner: string,
    repo: string,
    number: string
  ): Promise<ForgejoDiff> {
    const details = await this.pullDetails(
      await this.connection(),
      owner,
      repo,
      number
    );
    return {
      base: details.base,
      commitId: details.headSha || undefined,
      head: details.head,
      pull: details.pull,
      ...(await this.patch(owner, repo, number)),
    };
  }
  async review(
    owner: string,
    repo: string,
    number: string,
    input: Record<string, unknown>
  ): Promise<{ sent: true }> {
    if (
      typeof input.commitId !== "string" ||
      !/^[0-9a-f]{40,64}$/iu.test(input.commitId) ||
      typeof input.body !== "string" ||
      input.body.length > 100_000 ||
      !["COMMENT", "APPROVED", "REQUEST_CHANGES"].includes(
        String(input.event)
      ) ||
      !Array.isArray(input.comments) ||
      input.comments.length > 200
    ) {
      throw new ForgejoError("Invalid review.");
    }
    const comments = input.comments.map((c) => {
      if (
        !c ||
        typeof c.path !== "string" ||
        !c.path ||
        typeof c.body !== "string" ||
        !c.body.trim() ||
        c.body.length > 100_000 ||
        !Number.isSafeInteger(c.old_position) ||
        !Number.isSafeInteger(c.new_position) ||
        !(
          (c.old_position > 0 && c.new_position === 0) ||
          (c.new_position > 0 && c.old_position === 0)
        )
      ) {
        throw new ForgejoError("Invalid review comment.");
      }
      return {
        body: c.body,
        new_position: c.new_position,
        old_position: c.old_position,
        path: c.path,
      };
    });
    if (input.event === "COMMENT" && !input.body.trim() && !comments.length) {
      throw new ForgejoError("Add a comment before sending the review.");
    }
    const diff = await this.diff(owner, repo, number);
    if (diff.pull.state !== "open") {
      throw new ForgejoError("This pull request is no longer open.");
    }
    if (diff.commitId !== input.commitId) {
      throw new ForgejoError(
        "The PR changed. Refresh its diff before sending a review."
      );
    }
    await this.request(
      await this.connection(),
      `repos/${segment(owner)}/${segment(repo)}/pulls/${number}/reviews`,
      "application/json",
      undefined,
      {
        body: input.body,
        comments,
        commit_id: input.commitId,
        event: input.event,
      }
    );
    return { sent: true };
  }
}

interface RawComment {
  id: number;
  user?: { login: string };
  body: string;
  updated_at: string;
  path?: string;
  position?: number;
  original_position?: number;
  diff_hunk?: string;
  resolver?: { login: string } | null;
}
const comment = (v: RawComment): ForgejoComment => ({
  author: v.user?.login ?? "",
  body: v.body ?? "",
  diffHunk: v.diff_hunk,
  id: v.id,
  line: v.position,
  oldLine: v.original_position,
  path: v.path,
  resolved: !!v.resolver,
  updatedAt: v.updated_at,
});
const safeWebUrl = (value?: string): string | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};
