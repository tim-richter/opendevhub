import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type {
  CheckDef,
  CheckResult,
  CheckRun,
  ChecksConfig,
  ChecksView,
  Project,
  ProjectId,
} from "../shared/types";
import type { ProjectSettingsStore } from "./config";
import type { Containers, ExecTarget } from "./containers";
import type { RunResult, Runner } from "./exec";
import { cleanLogLine } from "./log-buffer";
import { BusyError, NotFoundError } from "./orchestrator";
import { InvalidRequestError } from "./worktrees";

export const DEFAULT_TIMEOUT_S = 900;
const MIN_TIMEOUT_S = 10;
const MAX_TIMEOUT_S = 7200;
const MAX_NAME = 40;
const MAX_COMMAND = 4000;
/** Lines of output kept per check. */
const OUTPUT_LINES = 500;
/** How long the client waits past a check's own timeout before giving up on it. */
const GRACE_MS = 30_000;

/**
 * Runs a check's command in its folder, under `timeout` when the container has one that takes `-k`
 * (it signals the command's whole process group, so a timed-out check leaves nothing running).
 */
const CONTAINER_SCRIPT = [
  'cd "$1" || exit 125',
  'if timeout -k 1 5 true >/dev/null 2>&1; then exec timeout -k 10 "$2" sh -c "$3"; fi',
  'exec sh -c "$3"',
].join("\n");

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Validates a `checks` list; invalid entries are dropped and described. */
export const parseChecks = (
  raw: unknown
): {
  checks: CheckDef[];
  errors: string[];
} => {
  if (raw === undefined) {
    return { checks: [], errors: [] };
  }
  if (!Array.isArray(raw)) {
    return { checks: [], errors: ["checks must be a list"] };
  }
  const checks: CheckDef[] = [];
  const errors: string[] = [];
  for (const [i, value] of raw.entries()) {
    const entry = record(value);
    const label =
      typeof entry?.name === "string" && entry.name.trim()
        ? `"${entry.name.trim()}"`
        : `#${i + 1}`;
    const fail = (why: string) => errors.push(`check ${label}: ${why}`);
    if (!entry) {
      fail("must be an object");
      continue;
    }
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name || name.length > MAX_NAME) {
      fail(`needs a name of 1 to ${MAX_NAME} characters`);
      continue;
    }
    if (checks.some((c) => c.name === name)) {
      fail("the name is used twice");
      continue;
    }
    const command =
      typeof entry.command === "string" ? entry.command.trim() : "";
    if (!command || command.length > MAX_COMMAND) {
      fail(`needs a command of 1 to ${MAX_COMMAND} characters`);
      continue;
    }
    const where = entry.where ?? "container";
    if (where !== "container" && where !== "host") {
      fail('where must be "container" or "host"');
      continue;
    }
    const timeout = entry.timeout ?? DEFAULT_TIMEOUT_S;
    if (
      typeof timeout !== "number" ||
      !Number.isInteger(timeout) ||
      timeout < MIN_TIMEOUT_S ||
      timeout > MAX_TIMEOUT_S
    ) {
      fail(
        `timeout must be whole seconds from ${MIN_TIMEOUT_S} to ${MAX_TIMEOUT_S}`
      );
      continue;
    }
    checks.push({ command, name, timeout, where });
  }
  return { checks, errors };
};

/** What approving a host command stores: it covers this exact text only. */
export const hostCheckHash = (command: string): string =>
  createHash("sha256").update(`host\0${command}`).digest("hex");

// Match strings first so literal comma/bracket sequences are left intact.
const JSONC_STRING_OR_TRAILING_COMMA = /"(?:\\.|[^"\\])*"|,(?<g1>\s*[}\]])/gu;

/** JSON with `//` and block comments and trailing commas, as devcontainer.json allows. */
export const parseJsonc = (text: string): unknown => {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i += 1;
      }
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) {
        throw new SyntaxError("Unterminated JSONC block comment");
      }
      out += " ";
      i = end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return JSON.parse(
    out.replaceAll(
      JSONC_STRING_OR_TRAILING_COMMA,
      (match, closing: string | undefined) => closing ?? match
    )
  );
};

/**
 * The checks that apply: the project's own list in config.json replaces devcontainer.json's.
 * `custom` is `customizations.opendevhub`; `settings` is the project's config.json entry.
 */
export const resolveChecks = (
  custom: unknown,
  settings: Record<string, unknown>,
  extraErrors: string[] = []
): ChecksConfig => {
  const fromFile = parseChecks(record(custom)?.checks);
  const own =
    settings.checks === undefined ? undefined : parseChecks(settings.checks);
  const approved = new Set(
    Array.isArray(settings.approvedHostChecks)
      ? settings.approvedHostChecks
      : []
  );
  const active = own ?? fromFile;
  let source: ChecksConfig["source"] = "none";
  if (own) {
    source = "settings";
  } else if (fromFile.checks.length > 0) {
    source = "devcontainer";
  }
  return {
    checks: active.checks.map((c) => ({
      ...c,
      approved:
        c.where === "container" || approved.has(hostCheckHash(c.command)),
    })),
    source,
    devcontainer: fromFile.checks,
    ...(own ? { settings: own.checks } : {}),
    errors: [
      ...extraErrors,
      ...fromFile.errors.map((e) => `devcontainer.json: ${e}`),
      ...(own?.errors ?? []).map((e) => `settings: ${e}`),
    ],
  };
};

/** `<project>-<branch>` as docker compose accepts it, so worktrees don't share a compose project. */
export const composeProjectName = (
  projectPath: string,
  branch: string
): string =>
  `${path.basename(projectPath)}-${branch}`
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/gu, "-")
    .replaceAll(/^[-_]+|-+$/gu, "");

/** A checkout as checks see it: where its commands run, and why they can't. */
export interface CheckTarget {
  project: Project;
  /** The environment serving the checkout, for container checks. */
  exec: ExecTarget;
  /** Set when that environment isn't running. */
  unavailable?: string;
  checkout: { container: string; host?: string };
  isMain: boolean;
}

export interface ChecksDeps {
  /** Validates the directory and finds its environment; throws for unknown projects and directories. */
  target: (projectId: ProjectId, directory: string) => CheckTarget;
  project: (projectId: ProjectId) => Project | undefined;
  containers: Pick<Containers, "exec">;
  run: Runner;
  git: {
    head: (p: Project, dir: string) => Promise<string | undefined>;
    isClean: (p: Project, dir: string) => Promise<boolean>;
    currentBranch: (p: Project, dir: string) => Promise<string | undefined>;
  };
  settings: ProjectSettingsStore;
  log: (projectId: ProjectId, line: string) => void;
  readFile?: (file: string) => Promise<string>;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
}

export class ChecksRunningError extends BusyError {
  constructor(directory: string) {
    super(directory, `checks are already running in ${directory}`);
    this.name = "ChecksRunningError";
  }
}

const seconds = (ms: number): string =>
  ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;

/** Runs a project's checks on a checkout, one run per checkout at a time, and keeps the latest run. */
export class Checks {
  private readonly runs = new Map<string, CheckRun>();
  private readonly running = new Set<string>();

  private readonly deps: ChecksDeps;
  constructor(deps: ChecksDeps) {
    this.deps = deps;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private requireProject(projectId: ProjectId): Project {
    const project = this.deps.project(projectId);
    if (!project) {
      throw new NotFoundError(projectId);
    }
    return project;
  }

  /** devcontainer.json is read from the main checkout on this machine each time, so edits apply at once. */
  async config(projectId: ProjectId): Promise<ChecksConfig> {
    const project = this.requireProject(projectId);
    const read = this.deps.readFile ?? ((f: string) => fs.readFile(f, "utf-8"));
    let custom: unknown;
    const errors: string[] = [];
    try {
      const json = record(parseJsonc(await read(project.devcontainerPath)));
      custom = record(json?.customizations)?.opendevhub;
    } catch (error) {
      errors.push(
        `could not read ${project.devcontainerPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return resolveChecks(custom, this.deps.settings.get(project.path), errors);
  }

  /** The checks, and with a directory its latest run and whether that run still describes it. */
  async view(projectId: ProjectId, directory?: string): Promise<ChecksView> {
    if (directory === undefined) {
      return this.config(projectId);
    }
    const target = this.deps.target(projectId, directory);
    const [config, state] = await Promise.all([
      this.config(projectId),
      this.state(target.project, directory),
    ]);
    const run = this.runs.get(this.key(projectId, directory));
    if (!run) {
      return config;
    }
    return {
      ...config,
      current:
        run.head !== undefined &&
        run.head === state.head &&
        run.dirty === state.dirty,
      run: structuredClone(run),
    };
  }

  /** The latest run alone, for polling while it goes. */
  latest(projectId: ProjectId, directory: string): { run?: CheckRun } {
    this.requireProject(projectId);
    const run = this.runs.get(this.key(projectId, directory));
    return run ? { run: structuredClone(run) } : {};
  }

  /** Saves the project's own list (approving its host commands), or removes it with null. */
  // oxlint-disable-next-line eslint/require-await -- async so that validation errors reject instead of throwing
  async saveSettings(
    projectId: ProjectId,
    checks: unknown
  ): Promise<ChecksConfig> {
    const project = this.requireProject(projectId);
    if (checks === null) {
      this.deps.settings.update(project.path, { checks: undefined });
      return this.config(projectId);
    }
    if (!Array.isArray(checks)) {
      throw new InvalidRequestError(
        "checks must be a list, or null to use devcontainer.json"
      );
    }
    const parsed = parseChecks(checks);
    if (parsed.errors.length > 0) {
      throw new InvalidRequestError(parsed.errors.join("; "));
    }
    const hosts = parsed.checks
      .filter((c) => c.where === "host")
      .map((c) => hostCheckHash(c.command));
    this.deps.settings.update(project.path, {
      checks: parsed.checks,
      ...(hosts.length > 0
        ? { approvedHostChecks: this.approvedWith(project, hosts) }
        : {}),
    });
    return this.config(projectId);
  }

  /**
   * Starts a run of all checks, or of the named ones (keeping the others' results when the last run is
   * still current). `approve` lists host commands the user saw and accepted.
   */
  async start(
    projectId: ProjectId,
    directory: string,
    opts: { names?: string[]; approve?: string[] } = {}
  ): Promise<CheckRun> {
    const target = this.deps.target(projectId, directory);
    const key = this.key(projectId, directory);
    if (this.running.has(key)) {
      throw new ChecksRunningError(directory);
    }
    this.running.add(key);
    try {
      const { run, timeouts } = await this.prepare(target, directory, opts);
      this.runs.set(key, run);
      void this.execute(target, run, timeouts).finally(() =>
        this.running.delete(key)
      );
      return structuredClone(run);
    } catch (error) {
      this.running.delete(key);
      throw error;
    }
  }

  private async prepare(
    target: CheckTarget,
    directory: string,
    opts: { names?: string[]; approve?: string[] }
  ): Promise<{ run: CheckRun; timeouts: Map<string, number> }> {
    const { project } = target;
    let config = await this.config(project.id);
    const approve = (opts.approve ?? []).filter((cmd) =>
      config.checks.some((c) => c.where === "host" && c.command === cmd)
    );
    if (approve.length > 0) {
      this.deps.settings.update(project.path, {
        approvedHostChecks: this.approvedWith(
          project,
          approve.map(hostCheckHash)
        ),
      });
      config = await this.config(project.id);
    }
    if (config.checks.length === 0) {
      throw new InvalidRequestError("this project has no checks");
    }
    const unknown = (opts.names ?? []).filter(
      (n) => !config.checks.some((c) => c.name === n)
    );
    if (unknown.length > 0) {
      throw new InvalidRequestError(`unknown check ${unknown.join(", ")}`);
    }
    const names = opts.names ?? [];
    const selected =
      names.length > 0
        ? config.checks.filter((c) => names.includes(c.name))
        : config.checks;
    const blocked = selected.filter((c) => !c.approved);
    if (blocked.length > 0) {
      throw new InvalidRequestError(
        `approve the host command of ${blocked.map((c) => c.name).join(", ")} before running it`
      );
    }

    const state = await this.state(project, directory);
    const previous = this.runs.get(this.key(project.id, directory));
    const kept =
      previous &&
      previous.head === state.head &&
      previous.dirty === state.dirty &&
      opts.names?.length
        ? previous.results
        : [];
    const results: CheckResult[] = [];
    for (const c of config.checks) {
      if (selected.includes(c)) {
        results.push({
          command: c.command,
          name: c.name,
          output: [],
          status: "queued",
          where: c.where,
        });
        continue;
      }
      const old = kept.find(
        (r) =>
          r.name === c.name && r.command === c.command && r.where === c.where
      );
      if (old && old.status !== "queued" && old.status !== "running") {
        results.push(old);
      }
    }
    return {
      run: {
        directory,
        ...(state.head ? { head: state.head } : {}),
        dirty: state.dirty,
        startedAt: this.now(),
        results,
      },
      timeouts: new Map(selected.map((c) => [c.name, c.timeout])),
    };
  }

  private async execute(
    target: CheckTarget,
    run: CheckRun,
    timeouts: Map<string, number>
  ): Promise<void> {
    const branch = await this.deps.git
      .currentBranch(target.project, run.directory)
      .catch(() => undefined);
    for (const result of run.results) {
      if (result.status !== "queued") {
        continue;
      }
      await this.runOne(
        target,
        run.directory,
        result,
        timeouts.get(result.name) ?? DEFAULT_TIMEOUT_S,
        branch
      );
    }
    run.finishedAt = this.now();
  }

  private async runOne(
    target: CheckTarget,
    directory: string,
    result: CheckResult,
    timeout: number,
    branch: string | undefined
  ): Promise<void> {
    const { project } = target;
    const fail = (reason: string) => {
      result.status = "error";
      result.reason = reason;
      this.deps.log(
        project.id,
        `checks: ${result.name} could not run: ${reason}`
      );
    };
    if (result.where === "container" && target.unavailable) {
      return fail(target.unavailable);
    }
    if (result.where === "host" && !target.checkout.host) {
      return fail(
        "this checkout isn't on this machine, so host checks can't run here"
      );
    }

    result.status = "running";
    const started = this.now();
    const onLine = (raw: string) => {
      const line = cleanLogLine(raw);
      if (!line) {
        return;
      }
      result.output.push(line);
      if (result.output.length > OUTPUT_LINES) {
        result.output.splice(0, result.output.length - OUTPUT_LINES);
      }
    };
    const env: Record<string, string> = {
      OPENDEVHUB_CHECK: result.name,
      ...(branch ? { OPENDEVHUB_BRANCH: branch } : {}),
    };
    let r: RunResult;
    try {
      if (result.where === "host") {
        const outer = this.deps.env ?? process.env;
        if (!target.isMain && branch && !outer.COMPOSE_PROJECT_NAME) {
          env.COMPOSE_PROJECT_NAME = composeProjectName(project.path, branch);
        }
        r = await this.deps.run("sh", ["-c", result.command], {
          cwd: target.checkout.host,
          detached: true,
          env,
          onLine,
          timeoutMs: timeout * 1000,
        });
      } else {
        r = await this.deps.containers.exec(
          target.exec,
          [
            "sh",
            "-c",
            CONTAINER_SCRIPT,
            "sh",
            directory,
            String(timeout),
            result.command,
          ],
          {
            env,
            onLine,
            timeoutMs: timeout * 1000 + GRACE_MS,
          }
        );
        // `timeout` exits 124 (137 after -k) when the check ran out of time.
        if (
          !r.timedOut &&
          (r.exitCode === 124 || r.exitCode === 137) &&
          this.now() - started >= timeout * 1000
        ) {
          r = { ...r, timedOut: true };
        }
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    result.durationMs = this.now() - started;
    result.exitCode = r.exitCode;
    if (r.timedOut) {
      result.timedOut = true;
    }
    result.status = r.exitCode === 0 && !r.timedOut ? "passed" : "failed";
    let how;
    if (result.status === "passed") {
      how = "passed";
    } else if (r.timedOut) {
      how = `timed out after ${timeout} s`;
    } else {
      how = `failed (exit ${r.exitCode})`;
    }
    this.deps.log(
      project.id,
      `checks: ${result.name} ${how} in ${seconds(result.durationMs)}`
    );
  }

  private async state(
    project: Project,
    directory: string
  ): Promise<{ head?: string; dirty: boolean }> {
    const [head, clean] = await Promise.all([
      this.deps.git.head(project, directory).catch(() => undefined),
      this.deps.git.isClean(project, directory).catch(() => true),
    ]);
    return { ...(head ? { head } : {}), dirty: !clean };
  }

  private approvedWith(project: Project, hashes: string[]): string[] {
    const current = this.deps.settings.get(project.path).approvedHostChecks;
    const list = Array.isArray(current)
      ? current.filter((h): h is string => typeof h === "string")
      : [];
    return [...new Set([...list, ...hashes])];
  }

  private key(projectId: ProjectId, directory: string): string {
    return `${projectId}\0${directory}`;
  }
}
