import type {
  ForgeKind,
  Project,
  PublishInfo,
  PublishRequest,
  PublishResult,
} from "../../shared/types";
import type { ForgeStore } from "../config";
import { CommandError, tailLines } from "../environments/containers";
import type { Containers } from "../environments/containers";
import type { RunResult, Runner } from "../nodes/exec";
import {
  agitPushArgs,
  branchPushArgs,
  compareUrl,
  defaultStrategy,
  isPrUrl,
  parseRemote,
  pushUrls,
  resolveForge,
  strategiesFor,
} from "./forge";
import type { Forge, RemoteInfo } from "./forge";
import { InvalidRequestError } from "./worktrees";

const PROBE_TIMEOUT_MS = 3000;

/** true/false: the host answered (with / without a Forgejo-style version); undefined: it didn't answer at all. */
const answers = async (
  url: string,
  fetchImpl: typeof fetch
): Promise<boolean | undefined> => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: abort.signal,
    });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json().catch(() => undefined)) as
      | { version?: unknown }
      | undefined;
    return typeof body?.version === "string";
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
};

/** One unauthenticated look at a host's API: Forgejo first, then Gitea. undefined means the host was unreachable. */
export const probeForge = async (
  web: string,
  fetchImpl: typeof fetch = fetch
): Promise<ForgeKind | undefined> => {
  const base = web.replace(/\/$/u, "");
  const forgejo = await answers(`${base}/api/forgejo/v1/version`, fetchImpl);
  if (forgejo) {
    return "forgejo";
  }
  const gitea = await answers(`${base}/api/v1/version`, fetchImpl);
  if (gitea) {
    return "gitea";
  }
  return forgejo === undefined || gitea === undefined ? undefined : "unknown";
};

/** The forge for a remote; a host nobody configured is probed once and the answer (even "unknown") remembered; an unreachable one isn't. */
export const detectForge = async (
  remote: RemoteInfo | undefined,
  store: ForgeStore,
  fetchImpl: typeof fetch = fetch
): Promise<Forge> => {
  const known = resolveForge(remote, store.all());
  if (known) {
    return known;
  }
  if (!remote || !remote.host.includes(".")) {
    return { kind: "unknown" };
  }
  const kind = await probeForge(remote.web, fetchImpl);
  if (!kind) {
    return { kind: "unknown" };
  }
  store.remember(remote.host, { kind });
  return resolveForge(remote, store.all()) ?? { kind: "unknown" };
};

const GIT_TIMEOUT_MS = 30_000;
const PUSH_TIMEOUT_MS = 120_000;
/** A push must fail on a missing credential, never wait for someone to type one. */
const NO_PROMPT = { GIT_TERMINAL_PROMPT: "0" };

/** One checkout as the container sees it and, when it's on this machine too, as the host sees it. */
export interface Checkout {
  container: string;
  host?: string;
}

export interface PublisherDeps {
  containers: Pick<Containers, "exec">;
  run: Runner;
  forges: ForgeStore;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

interface Location {
  where: "host" | "container";
  dir: string;
}

export class Publisher {
  private readonly deps: PublisherDeps;
  constructor(deps: PublisherDeps) {
    this.deps = deps;
  }

  /** Push from the host when the checkout works there, so your own ssh-agent and credential helpers apply. */
  async location(p: Project, checkout: Checkout): Promise<Location> {
    const forced = (this.deps.env ?? process.env).OPENDEVHUB_PUSH;
    if (forced === "container" || !checkout.host) {
      if (forced === "host") {
        throw new CommandError(
          `OPENDEVHUB_PUSH=host, but ${checkout.container} isn't on this machine`
        );
      }
      return { dir: checkout.container, where: "container" };
    }
    const r = await this.deps.run(
      "git",
      ["-C", checkout.host, "rev-parse", "--git-dir"],
      { detached: true, env: NO_PROMPT, timeoutMs: GIT_TIMEOUT_MS }
    );
    if (r.exitCode === 0) {
      return { dir: checkout.host, where: "host" };
    }
    if (forced === "host") {
      throw new CommandError(
        `OPENDEVHUB_PUSH=host, but git can't use ${checkout.host} on this machine`
      );
    }
    return { dir: checkout.container, where: "container" };
  }

  private exec(
    p: Project,
    loc: Location,
    args: string[],
    timeoutMs = GIT_TIMEOUT_MS
  ): Promise<RunResult> {
    return loc.where === "host"
      ? this.deps.run("git", ["-C", loc.dir, ...args], {
          detached: true,
          env: NO_PROMPT,
          timeoutMs,
        })
      : this.deps.containers.exec(p, ["git", "-C", loc.dir, ...args], {
          env: NO_PROMPT,
          timeoutMs,
        });
  }

  private async config(
    p: Project,
    loc: Location,
    key: string
  ): Promise<string | undefined> {
    const r = await this.exec(p, loc, ["config", "--get", key]);
    return r.exitCode === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
  }

  private async forge(
    p: Project,
    loc: Location,
    remote: string | undefined
  ): Promise<{ remote?: RemoteInfo; forge: Forge }> {
    if (!remote) {
      return { forge: { kind: "unknown" } };
    }
    // The configured URL, before any `insteadOf` rewrite, names the forge the user means.
    const url = await this.config(p, loc, `remote.${remote}.url`);
    const info = url ? parseRemote(url) : undefined;
    return {
      forge: await detectForge(info, this.deps.forges, this.deps.fetchImpl),
      remote: info,
    };
  }

  async info(
    p: Project,
    checkout: Checkout,
    branch: string | undefined,
    remote?: string
  ): Promise<PublishInfo> {
    const loc = await this.location(p, checkout);
    const result = await this.exec(p, loc, ["remote"]);
    const remotes = result.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .toSorted();
    let chosen;
    if (remote && remotes.includes(remote)) {
      chosen = remote;
    } else if (remotes.includes("origin")) {
      chosen = "origin";
    } else {
      [chosen] = remotes;
    }
    const { forge } = await this.forge(p, loc, chosen);
    return {
      ...(branch ? { branch } : {}),
      remotes,
      ...(chosen ? { remote: chosen } : {}),
      forge,
      strategies: strategiesFor(forge.kind),
      strategy: defaultStrategy(forge.kind),
      pushFrom: loc.where,
    };
  }

  /**
   * Pushes the branch (or an AGit ref) and reports what the forge said; the caller records it. `previousPr` is the
   * pull request the branch was published to before, if any. Never force-pushes.
   */
  async publish(
    p: Project,
    checkout: Checkout,
    branch: string,
    req: PublishRequest,
    previousPr?: string
  ): Promise<PublishResult> {
    const loc = await this.location(p, checkout);
    const { forge } = await this.forge(p, loc, req.remote);
    if (!strategiesFor(forge.kind).includes(req.strategy)) {
      throw new InvalidRequestError(
        `AGit publishing needs a Forgejo or Gitea remote; ${req.remote} is ${forge.kind}`
      );
    }
    const args =
      req.strategy === "agit"
        ? agitPushArgs({
            base: req.base,
            description: req.description,
            remote: req.remote,
            title: req.title,
            topic: branch,
          })
        : branchPushArgs({ branch, remote: req.remote });
    const r = await this.exec(p, loc, args, PUSH_TIMEOUT_MS);
    const output = `${r.stderr}\n${r.stdout}`;
    if (r.timedOut) {
      throw new CommandError(
        `git push timed out after ${PUSH_TIMEOUT_MS / 1000} s (waiting for credentials?)`,
        tailLines(output, 8)
      );
    }
    if (r.exitCode !== 0) {
      const tail = tailLines(output, 8);
      if (/\[rejected\]|non-fast-forward|fetch first/u.test(output)) {
        throw new CommandError(
          `the branch on ${req.remote} has commits this one doesn't (pushed from elsewhere, or rebased); pull them in with \`git pull ${req.remote} ${branch}\`, then publish again`,
          tail
        );
      }
      throw new CommandError(
        `git push failed: ${tail.at(-1) ?? `exit ${r.exitCode}`}`,
        tail
      );
    }

    const urls = pushUrls(output);
    const prUrl = urls.find(isPrUrl);
    const compare =
      req.strategy === "branch"
        ? compareUrl(forge, {
            base: req.base,
            body: req.description,
            branch,
            title: req.title,
          })
        : undefined;
    return {
      forge: forge.kind,
      strategy: req.strategy,
      pushedFrom: loc.where,
      ...(prUrl ? { prUrl } : {}),
      ...((prUrl ?? compare ?? urls[0])
        ? { openUrl: prUrl ?? compare ?? urls[0] }
        : {}),
      ...(previousPr && prUrl && previousPr !== prUrl
        ? {
            notice:
              "The earlier pull request was closed or merged; this opened a new one.",
          }
        : {}),
      output: tailLines(output, 12),
    };
  }
}
