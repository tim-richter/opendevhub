import type { ForgeKind, PublishStrategy } from "../shared/types";

/** A remote's location on its forge. `web` is the web origin (scheme://host[:port]) and never holds credentials. */
export interface RemoteInfo {
  host: string;
  path: string;
  web: string;
}

export interface ForgeEntry {
  kind: ForgeKind;
  /** Web origin when it differs from the ssh host, e.g. for an ssh alias. */
  web?: string;
}

export interface Forge {
  kind: ForgeKind;
  webBase?: string;
}

const WELL_KNOWN: Record<string, ForgeKind> = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "codeberg.org": "forgejo",
  "bitbucket.org": "bitbucket",
};

function cleanPath(p: string): string | undefined {
  const path = p.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return path.includes("/") && !path.split("/").some((s) => !s || s === "..") ? path : undefined;
}

/** `git remote get-url` output as host, repository path and web origin; undefined for local paths. */
export function parseRemote(url: string): RemoteInfo | undefined {
  const raw = url.trim();
  if (!raw) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return undefined;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(u.pathname);
    } catch {
      return undefined;
    }
    const path = cleanPath(decoded);
    if (!path || !u.hostname) return undefined;
    if (u.protocol === "http:" || u.protocol === "https:") return { host: u.hostname, path, web: `${u.protocol}//${u.host}` };
    if (u.protocol === "ssh:" || u.protocol === "git+ssh:") return { host: u.hostname, path, web: `https://${u.hostname}` };
    return undefined;
  }
  const scp = raw.match(/^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/);
  if (!scp) return undefined;
  const path = cleanPath(scp[2]);
  return path ? { host: scp[1], path, web: `https://${scp[1]}` } : undefined;
}

/** The forge for a remote from config or well-known hosts; undefined means "probe it"; no remote means unknown. */
export function resolveForge(remote: RemoteInfo | undefined, forges: Record<string, ForgeEntry>): Forge | undefined {
  if (!remote) return { kind: "unknown" };
  const entry = forges[remote.host];
  if (entry) {
    return entry.kind === "unknown" ? { kind: "unknown" } : { kind: entry.kind, webBase: `${(entry.web ?? remote.web).replace(/\/$/, "")}/${remote.path}` };
  }
  const known = WELL_KNOWN[remote.host];
  return known ? { kind: known, webBase: `${remote.web}/${remote.path}` } : undefined;
}

const segments = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");
const MAX_GITHUB_URL = 8000;

/** The forge's "new pull request" page with what it can prefill; none for unknown forges. */
export function compareUrl(forge: Forge, o: { base: string; branch: string; title: string; body: string }): string | undefined {
  const web = forge.webBase;
  if (!web) return undefined;
  switch (forge.kind) {
    case "github": {
      const at = `${web}/compare/${segments(o.base)}...${segments(o.branch)}?`;
      const build = (body: string) => at + new URLSearchParams({ quick_pull: "1", title: o.title, body });
      let body = o.body;
      let url = build(body);
      while (url.length > MAX_GITHUB_URL && body.length > 0) {
        body = body.slice(0, Math.max(0, body.length - Math.ceil((url.length - MAX_GITHUB_URL) / 3) - 1));
        url = build(`${body}…`);
      }
      return url;
    }
    case "gitlab":
      return `${web}/-/merge_requests/new?${new URLSearchParams({
        "merge_request[source_branch]": o.branch,
        "merge_request[target_branch]": o.base,
        "merge_request[title]": o.title,
        "merge_request[description]": o.body,
      })}`;
    case "forgejo":
    case "gitea":
      return `${web}/compare/${segments(o.base)}...${segments(o.branch)}`;
    case "bitbucket":
      return `${web}/pull-requests/new?${new URLSearchParams({ source: o.branch, dest: o.base })}`;
    default:
      return undefined;
  }
}

/** Push options can't hold newlines. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Forgejo/Gitea AGit: the push itself opens (or updates) the pull request for `topic`. */
export function agitPushArgs(o: { remote: string; base: string; topic: string; title: string; description: string }): string[] {
  return [
    "push",
    o.remote,
    `HEAD:refs/for/${o.base}`,
    "-o",
    `topic=${o.topic}`,
    "-o",
    `title=${oneLine(o.title)}`,
    "-o",
    `description=${oneLine(o.description)}`,
  ];
}

export function branchPushArgs(o: { remote: string; branch: string }): string[] {
  return ["push", "--set-upstream", o.remote, `refs/heads/${o.branch}:refs/heads/${o.branch}`];
}

/** URLs the remote printed during the push (`remote:` lines), in order. */
export function pushUrls(output: string): string[] {
  const urls: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("remote:")) continue;
    for (const m of line.matchAll(/https?:\/\/[^\s'"<>]+/g)) urls.push(m[0].replace(/[.,;)]+$/, ""));
  }
  return urls;
}

/** An existing pull or merge request, as opposed to a "create one" link. */
export function isPrUrl(url: string): boolean {
  return /\/(pull|pulls|merge_requests|pull-requests)\/\d+(?:[/?#]|$)/.test(url);
}

export function splitTitleBody(text: string): { title: string; description: string } {
  const lines = text.trim().split(/\r?\n/);
  const title = oneLine(lines[0] ?? "");
  const description = lines.slice(1).join("\n").trim();
  return { title, description };
}

export function strategiesFor(kind: ForgeKind): PublishStrategy[] {
  return kind === "forgejo" || kind === "gitea" ? ["agit", "branch"] : ["branch"];
}

export function defaultStrategy(kind: ForgeKind): PublishStrategy {
  return strategiesFor(kind)[0];
}
