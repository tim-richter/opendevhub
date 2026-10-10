import { imageType, MAX_IMAGE_BYTES } from "../../shared/images";
import type { ImageSide } from "../../shared/images";
import type {
  Project,
  ProjectId,
  PublishInfo,
  PublishResult,
  ReviewBase,
  ReviewData,
  ReviewMode,
  ReviewTurn,
  SessionSummary,
  UpdateResult,
} from "../../shared/types";
import { USER } from "../db/events";
import type { ExecTarget } from "../environments/containers";
import type { Environments } from "../environments/environments";
import { repoOf } from "../environments/ports";
import type { GitPort, HubDeps } from "../environments/ports";
import { NotFoundError } from "../errors";
import { OpencodeHttpError } from "../opencode/client";
import type { RawFileDiff } from "../opencode/client";
import type { Sessions } from "../sessions/sessions";
import type { Checkouts } from "./checkouts";
import { splitTitleBody } from "./forge";
import {
  diffMode,
  isMessageId,
  isRepoPath,
  NO_LIMITS,
  resolveBase,
  toReviewFiles,
  toTurnPrompts,
  TURN_PROMPTS,
} from "./review";
import { InvalidRequestError, validateBranch } from "./worktrees";

const COMMIT_PROMPT =
  "Write a conventional commit message for the uncommitted changes. Reply with the message only.";
const PUBLISH_PROMPT =
  "Write a pull request title on the first line, then a blank line, then a short description of this branch's changes. Reply with that text only.";
const STRATEGIES: ReadonlySet<string> = new Set(["branch", "agit"]);
const REMOTE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/u;

/** The Review tab: what a checkout changed, and committing, updating, merging and publishing it. */
export class ReviewActions {
  private readonly deps: HubDeps;
  private readonly envs: Environments;
  private readonly sessions: Sessions;
  private readonly checkouts: Checkouts;
  constructor(
    deps: HubDeps,
    envs: Environments,
    sessions: Sessions,
    checkouts: Checkouts
  ) {
    this.deps = deps;
    this.envs = envs;
    this.sessions = sessions;
    this.checkouts = checkouts;
  }

  /** What changed in a checkout compared with its base, for the Review tab. */
  async review(
    id: ProjectId,
    directory: string,
    opts: {
      base?: string;
      mode?: ReviewMode;
      file?: string;
      /** Turn mode: the session (the checkout's latest by default) and the prompt whose turn to show (its newest). */
      session?: string;
      from?: string;
    } = {}
  ): Promise<ReviewData> {
    const project = this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    const request = opts.base?.trim() ? validateBranch(opts.base) : undefined;
    if (opts.from !== undefined && !isMessageId(opts.from)) {
      throw new InvalidRequestError(`invalid turn ${opts.from}`);
    }
    const session =
      opts.mode === "turn"
        ? this.turnSession(id, directory, opts.session)
        : undefined;
    const client = this.envs.opencodeClient(
      this.envs.envForDirectory(project, directory).id
    );
    const { git } = this.deps;
    const ws = this.envs.workspaceFolder(project);
    const on = this.checkouts.gitFor(project, directory);
    const { branch, base } = await this.reviewBase(project, directory, request);
    const mode = diffMode(opts.mode, base, session !== undefined);
    const [[raw, turn], status, counts, pushed, wsBranch, wsClean] =
      await Promise.all([
        session && mode === "turn"
          ? this.turnDiff(id, directory, session, opts.from)
          : client
              .vcsDiff(
                directory,
                mode === "branch" ? "branch" : "working",
                mode === "branch" ? base?.name : undefined
              )
              .then((d) => [d, undefined] as const),
        client.vcsStatus(directory),
        base
          ? on.git
              .aheadBehind(on.target, directory, base.name)
              .catch(() => ({ ahead: 0, behind: 0 }))
          : { ahead: 0, behind: 0 },
        branch ? this.pushed(id, on.git, on.target, directory, branch) : false,
        git.currentBranch(project, ws),
        git.isClean(project, ws),
      ]);
    const wanted =
      opts.file === undefined ? raw : raw.filter((f) => f.file === opts.file);
    const { files, truncated } = toReviewFiles(
      wanted,
      opts.file === undefined ? {} : NO_LIMITS
    );
    return {
      directory,
      ...(branch ? { branch } : {}),
      ...(base ? { base } : {}),
      mode,
      ...(turn ? { turn } : {}),
      ...counts,
      dirty: status.length > 0,
      pushed,
      workspace: { ...(wsBranch ? { branch: wsBranch } : {}), clean: wsClean },
      files,
      ...(truncated ? { truncated } : {}),
    };
  }

  /** The checkout's branch and the base a review compares it with. */
  private async reviewBase(
    project: Project,
    directory: string,
    request: string | undefined
  ): Promise<{ branch?: string; base?: ReviewBase }> {
    const client = this.envs.opencodeClient(
      this.envs.envForDirectory(project, directory).id
    );
    const on = this.checkouts.gitFor(project, directory);
    const branch = await on.git.currentBranch(on.target, directory);
    const [config, opencodeBase, info] = await Promise.all([
      branch ? on.git.recordedBase(on.target, directory, branch) : undefined,
      client.vcsBase(directory).catch(() => undefined),
      client.vcsInfo(directory).catch((): { default?: string } => ({})),
    ]);
    const base = resolveBase({
      config,
      defaultBranch: info.default,
      opencode: opencodeBase,
      request,
    });
    return { ...(branch ? { branch } : {}), ...(base ? { base } : {}) };
  }

  /**
   * One version of a changed image for the Review tab: `old` from the commit the diff compares with (HEAD, or the
   * merge-base with the base), `new` from the working copy. Undefined where that version doesn't exist.
   */
  async reviewImage(
    id: ProjectId,
    directory: string,
    opts: { file: string; side: ImageSide; mode?: ReviewMode; base?: string }
  ): Promise<{ bytes: Buffer; type: string } | undefined> {
    const project = this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    const type = imageType(opts.file);
    if (!type || !isRepoPath(opts.file)) {
      throw new InvalidRequestError(
        `not an image in the checkout: ${opts.file}`
      );
    }
    const on = this.checkouts.gitFor(project, directory);
    let rev: string | undefined;
    if (opts.side === "old") {
      const request = opts.base?.trim() ? validateBranch(opts.base) : undefined;
      const { base } = await this.reviewBase(project, directory, request);
      rev =
        diffMode(opts.mode, base) === "branch" && base
          ? await on.git.mergeBase(on.target, directory, base.name)
          : "HEAD";
      if (!rev) {
        return undefined;
      }
    }
    const bytes = await on.git.fileBytes(on.target, directory, opts.file, {
      maxBytes: MAX_IMAGE_BYTES,
      ...(rev ? { rev } : {}),
    });
    return bytes && { bytes, type };
  }

  /** The session whose turns a review shows: the one asked for, which must work in `directory`, or the latest there. */
  private turnSession(
    id: ProjectId,
    directory: string,
    sessionId: string | undefined
  ): SessionSummary | undefined {
    if (!sessionId) {
      return this.sessions.latestSession(id, directory);
    }
    const found = this.deps.store
      .sessionsOf(id)
      .find((s) => s.id === sessionId && s.directory === directory);
    if (!found) {
      throw new NotFoundError(sessionId, "session");
    }
    return found;
  }

  /** What one of the session's turns changed (the newest unless `from` names its prompt), and the turns to pick from. */
  private async turnDiff(
    id: ProjectId,
    directory: string,
    session: SessionSummary,
    from: string | undefined
  ): Promise<readonly [RawFileDiff[], ReviewTurn]> {
    const client = this.envs.opencodeClient(session.envId ?? id);
    const prompts = toTurnPrompts(
      await client.userMessages(session.id, TURN_PROMPTS)
    );
    const shown = from ?? prompts[0]?.id;
    const turn: ReviewTurn = {
      latest: shown === prompts[0]?.id,
      prompts,
      running: session.status !== "idle",
      sessionId: session.id,
      sessionTitle: session.title,
      ...(shown ? { from: shown } : {}),
    };
    if (!shown) {
      return [[], turn] as const;
    }
    try {
      return [
        await client.sessionDiff(session.id, { from: shown }, directory),
        turn,
      ] as const;
    } catch (error) {
      if (error instanceof OpencodeHttpError && error.status === 404) {
        throw new NotFoundError(shown, "turn");
      }
      throw error;
    }
  }

  /** A commit message suggested by the target's latest session; empty when there is none or it fails. */
  async commitMessage(id: ProjectId, directory: string): Promise<string> {
    this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    const session = this.sessions.latestSession(id, directory);
    if (!session) {
      return "";
    }
    try {
      const result5 = await this.envs
        .opencodeClient(session.envId ?? id)
        .generate(session.id, COMMIT_PROMPT, directory);
      return result5.trim();
    } catch {
      return "";
    }
  }

  async commit(
    id: ProjectId,
    directory: string,
    message: string
  ): Promise<void> {
    const msg = message.trim();
    if (!msg) {
      throw new InvalidRequestError("the commit message is empty");
    }
    this.envs.checkDirectory(id, directory);
    await this.envs.withGit(id, async (p) => {
      const on = this.checkouts.gitFor(p, directory);
      if (await on.git.isClean(on.target, directory)) {
        throw new InvalidRequestError("there is nothing to commit");
      }
      await this.envs.gitAction(id, `commit in ${directory}`, () =>
        on.git.commit(on.target, directory, msg)
      );
    });
  }

  /**
   * Commits what changed under `paths`, if anything did, so that a new worktree based on the checkout's branch
   * has it; other changes stay uncommitted. Returns that branch; a detached HEAD is refused.
   */
  // oxlint-disable-next-line eslint/require-await -- async so that validation errors reject instead of throwing
  async commitPaths(
    id: ProjectId,
    directory: string,
    message: string,
    paths: readonly string[]
  ): Promise<{ branch: string; committed: boolean }> {
    this.envs.checkDirectory(id, directory);
    return this.envs.withGit(id, async (p) => {
      const on = this.checkouts.gitFor(p, directory);
      const branch = await on.git.currentBranch(on.target, directory);
      if (!branch) {
        throw new InvalidRequestError(`${directory} is on a detached HEAD`);
      }
      if (await on.git.isClean(on.target, directory, paths)) {
        return { branch, committed: false };
      }
      await this.envs.gitAction(
        id,
        `commit ${paths.join(", ")} in ${directory}`,
        () => on.git.commit(on.target, directory, message, paths)
      );
      return { branch, committed: true };
    });
  }

  /** Rebases the target onto its base, or merges the base in when the branch was pushed. Conflicts are aborted. */
  // oxlint-disable-next-line eslint/require-await -- async so that validation errors reject instead of throwing
  async updateFromBase(
    id: ProjectId,
    directory: string,
    base: string
  ): Promise<UpdateResult> {
    const ref = validateBranch(base);
    this.envs.checkDirectory(id, directory);
    return this.envs.withGit(id, async (p) => {
      const on = this.checkouts.gitFor(p, directory);
      const { git } = on;
      if (on.remote) {
        const kit = this.envs.kit(on.remote);
        // The base is always what this machine has, never a branch of the node's repository.
        const repo = repoOf(kit);
        await repo.pushBase(
          p,
          repo.layout(p, this.envs.workspaceFolder(p)),
          ref
        );
      }
      const branch = await git.currentBranch(on.target, directory);
      if (!branch) {
        throw new InvalidRequestError(`${directory} is not on a branch`);
      }
      if (!(await git.isClean(on.target, directory))) {
        throw new InvalidRequestError(
          "commit or discard the uncommitted changes first"
        );
      }
      const strategy = (await this.pushed(
        id,
        git,
        on.target,
        directory,
        branch
      ))
        ? "merge"
        : "rebase";
      const result = await this.envs.gitAction(
        id,
        `${strategy} ${branch} with ${ref}`,
        () => git.update(on.target, directory, ref, strategy)
      );
      if (result.conflicts) {
        this.envs.log(
          id,
          `review: conflicts in ${result.conflicts.join(", ")}; aborted, nothing changed`
        );
      }
      return result;
    });
  }

  /** Merges a worktree's branch into the main checkout, which must be clean and on the base. Does not push. */
  // oxlint-disable-next-line eslint/require-await -- async so that validation errors reject instead of throwing
  async mergeIntoBase(
    id: ProjectId,
    directory: string,
    base: string,
    ffOnly: boolean
  ): Promise<{ branch: string }> {
    const ref = validateBranch(base);
    this.envs.checkDirectory(id, directory);
    return this.envs.withGit(id, async (p) => {
      const { git } = this.deps;
      const ws = this.envs.workspaceFolder(p);
      if (directory === ws) {
        throw new InvalidRequestError(
          "merge a worktree into its base; the main checkout is the base"
        );
      }
      const on = this.checkouts.gitFor(p, directory);
      const branch = await on.git.currentBranch(on.target, directory);
      if (!branch) {
        throw new InvalidRequestError(`${directory} is not on a branch`);
      }
      if (!(await on.git.isClean(on.target, directory))) {
        throw new InvalidRequestError(
          `${branch} has uncommitted changes; commit them first`
        );
      }
      const wsBranch = await git.currentBranch(p, ws);
      if (wsBranch !== ref) {
        throw new InvalidRequestError(
          `the main checkout is on ${wsBranch ?? "a detached HEAD"}, not ${ref}`
        );
      }
      if (!(await git.isClean(p, ws))) {
        throw new InvalidRequestError(
          "the main checkout has uncommitted changes"
        );
      }
      if (on.remote) {
        await this.checkouts.fetchHome(p, directory);
      }
      await this.envs.gitAction(
        id,
        `merge ${branch} into ${ref}${ffOnly ? " (fast-forward only)" : ""}`,
        () => git.mergeInto(p, ws, branch, ffOnly)
      );
      return { branch };
    });
  }

  /** Where and how publishing would push this checkout. */
  async publishInfo(
    id: ProjectId,
    directory: string,
    remote?: string
  ): Promise<PublishInfo> {
    const project = this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    if (remote !== undefined && !REMOTE_NAME.test(remote)) {
      throw new InvalidRequestError(`invalid remote "${remote}"`);
    }
    const on = this.checkouts.gitFor(project, directory);
    const branch = await on.git.currentBranch(on.target, directory);
    // A node's repository has no remotes: its branch is published from this machine's checkout.
    const checkout = this.checkouts.checkout(
      project,
      on.remote ? this.envs.workspaceFolder(project) : directory
    );
    const info = await this.deps.publisher.info(
      project,
      checkout,
      branch,
      remote
    );
    const pr = branch
      ? this.deps.checkouts.branch(id, branch)?.prUrl
      : undefined;
    return pr ? { ...info, pr } : info;
  }

  /** Pushed: the branch has an upstream, or opendevhub published it. */
  private pushed(
    id: ProjectId,
    git: GitPort,
    target: ExecTarget,
    directory: string,
    branch: string
  ): Promise<boolean> {
    if (this.deps.checkouts.branch(id, branch)?.publishedRemote) {
      return Promise.resolve(true);
    }
    return git.isPushed(target, directory);
  }

  /** A PR title and description suggested by the target's latest session; empty when there is none or it fails. */
  async publishSuggestion(
    id: ProjectId,
    directory: string
  ): Promise<{ title: string; description: string }> {
    this.envs.requireProject(id);
    this.envs.checkDirectory(id, directory);
    const session = this.sessions.latestSession(id, directory);
    if (!session) {
      return { description: "", title: "" };
    }
    try {
      return splitTitleBody(
        await this.envs
          .opencodeClient(session.envId ?? id)
          .generate(session.id, PUBLISH_PROMPT, directory)
      );
    } catch {
      return { description: "", title: "" };
    }
  }

  /** Pushes the checkout's branch and opens (or links) its pull request. */
  // oxlint-disable-next-line eslint/require-await -- async so that validation errors reject instead of throwing
  async publish(
    id: ProjectId,
    directory: string,
    req: {
      remote: string;
      base: string;
      strategy: string;
      title: string;
      description: string;
    }
  ): Promise<PublishResult> {
    if (!REMOTE_NAME.test(req.remote)) {
      throw new InvalidRequestError(`invalid remote "${req.remote}"`);
    }
    const base = validateBranch(req.base);
    if (!STRATEGIES.has(req.strategy)) {
      throw new InvalidRequestError(`invalid strategy "${req.strategy}"`);
    }
    const title = req.title.trim();
    if (!title || title.length > 200) {
      throw new InvalidRequestError("the title must be 1 to 200 characters");
    }
    this.envs.checkDirectory(id, directory);
    return this.envs.withGit(id, async (p) => {
      const on = this.checkouts.gitFor(p, directory);
      const branch = await on.git.currentBranch(on.target, directory);
      if (!branch) {
        throw new InvalidRequestError(`${directory} is not on a branch`);
      }
      if (branch === base) {
        throw new InvalidRequestError(
          `publish a branch, not the base itself (${base})`
        );
      }
      if (on.remote) {
        await this.checkouts.fetchHome(p, directory);
      }
      const checkout = this.checkouts.checkout(
        p,
        on.remote ? this.envs.workspaceFolder(p) : directory
      );
      const strategy = req.strategy as "branch" | "agit";
      const result = await this.envs.gitAction(
        id,
        `publish ${branch} to ${req.remote} (${req.strategy})`,
        () =>
          this.deps.publisher.publish(
            p,
            checkout,
            branch,
            {
              base,
              description: req.description,
              remote: req.remote,
              strategy,
              title,
            },
            this.deps.checkouts.branch(id, branch)?.prUrl
          )
      );
      this.deps.checkouts.updateBranch(
        id,
        branch,
        {
          publishedAt: (this.deps.now ?? Date.now)(),
          publishedRemote: req.remote,
          ...(strategy === "agit" ? { agitTopic: branch } : {}),
          ...(result.prUrl
            ? {
                pull: {
                  url: result.prUrl,
                  ...(result.forge && result.forge !== "unknown"
                    ? { forge: result.forge }
                    : {}),
                },
              }
            : {}),
        },
        USER
      );
      return result;
    });
  }
}
