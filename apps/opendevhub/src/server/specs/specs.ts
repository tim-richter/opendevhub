import fs from "node:fs/promises";
import path from "node:path";

import { requirementChanges } from "../../shared/openspec";
import type {
  ProjectId,
  SessionSummary,
  SpecArtifact,
  SpecChange,
  SpecChangeSummary,
  SpecPhase,
  SpecView,
} from "../../shared/types";
import type { CheckTarget } from "../environments/checks";
import type { Containers } from "../environments/containers";
import { BusyError, UnavailableError } from "../errors";
import { InvalidRequestError } from "../git/worktrees";
import type { OpencodeClient } from "../opencode/client";
import { APPLY_COMMAND, UPDATE_COMMAND } from "../tasks/openspec";
import { patchTaskMetadata } from "../tasks/request";

const EXEC_TIMEOUT_MS = 60_000;
/** Ends each section of the script's output: `<MARK> <section> <exit code>`. */
const MARK = "@@opendevhub-spec@@";
/** The CLI's exit code when it isn't installed, from the script's own `openspec_`. */
const NOT_FOUND = 127;
const NO_CLI = "the container has no openspec CLI; add it to the devcontainer";
/** A capability's delta spec inside a change folder. */
const DELTA_SPEC = /^specs\/(?<cap>[^/]+)\/spec\.md$/u;
const CHANGE_NAME = /^[A-Za-z0-9][\w.-]*$/u;
/** `openspec archive` names a change's folder `<date>-<change>`. */
const ARCHIVED_DATE = /^\d{4}-\d{2}-\d{2}-/u;
/** Markdown read per change, so a runaway agent can't fill the page. */
const MAX_DOCUMENTS = 200;
const MAX_DOCUMENT_BYTES = 512 * 1024;

/**
 * Lists a checkout's OpenSpec changes and reports on one, in a single exec. Arguments: the checkout, then
 * `list` to run `openspec list`, `base` to list the changes on the branch's recorded base, a change name
 * for its `status` and `validate`, and `archive` to archive that change instead. `openspec` is found on PATH
 * or through a login shell, where npm, nvm and mise usually put it.
 */
const SPEC_SCRIPT = [
  'cd "$1" || exit 125',
  `mark() { printf '\\n%s %s %s\\n' '${MARK}' "$1" "$2"; }`,
  "openspec_() {",
  '  if command -v openspec >/dev/null 2>&1; then openspec "$@"; return; fi',
  "  for sh in bash zsh; do",
  '    command -v "$sh" >/dev/null 2>&1 || continue',
  "    \"$sh\" -lc 'command -v openspec' >/dev/null 2>&1 </dev/null || continue",
  '    "$sh" -lc \'openspec "$@"\' openspec "$@" </dev/null; return',
  "  done",
  `  echo "openspec: command not found"; return ${NOT_FOUND}`,
  "}",
  'if [ "$3" = base ]; then',
  "  branch=$(git symbolic-ref --short -q HEAD 2>/dev/null)",
  '  base=""',
  '  [ -n "$branch" ] && base=$(git config --get "branch.$branch.opendevhubBase" 2>/dev/null)',
  '  if [ -n "$base" ]; then git ls-tree -d --name-only "$base" openspec/changes/ 2>/dev/null; mark base $?; else mark base 1; fi',
  "fi",
  'if [ "$2" = list ]; then openspec_ list --json 2>&1; mark list $?; fi',
  'if [ -n "$4" ] && [ "$5" = archive ]; then',
  '  openspec_ archive "$4" --yes --json 2>&1; mark archive $?',
  'elif [ -n "$4" ]; then',
  '  openspec_ status --change "$4" --json 2>&1; mark status $?',
  '  openspec_ validate "$4" --json 2>&1; mark validate $?',
  "fi",
].join("\n");

interface Section {
  text: string;
  code: number;
}

/** The script's output by section. */
export const parseSections = (stdout: string): Map<string, Section> => {
  const sections = new Map<string, Section>();
  let lines: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.startsWith(`${MARK} `)) {
      const [, name = "", code = ""] = line.split(" ");
      sections.set(name, {
        code: Number(code),
        text: lines.join("\n").trim(),
      });
      lines = [];
    } else {
      lines.push(line);
    }
  }
  return sections;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The JSON object in a section; the CLI may print warnings around it. */
const sectionJson = (
  section: Section | undefined
): Record<string, unknown> | undefined => {
  const text = section?.text ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) {
    return undefined;
  }
  try {
    return record(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return undefined;
  }
};

const lastLine = (section: Section | undefined): string =>
  section?.text
    .split("\n")
    .findLast((l) => l.trim())
    ?.trim() ?? "no output";

/** The changes from a run with `list`; throws when the CLI is missing or fails. */
const listedChanges = (sections: Map<string, Section>): SpecChangeSummary[] => {
  const list = sections.get("list");
  if (list?.code === NOT_FOUND) {
    throw new UnavailableError(NO_CLI);
  }
  const listJson = list?.code === 0 ? sectionJson(list) : undefined;
  if (!listJson) {
    throw new UnavailableError(`openspec list failed: ${lastLine(list)}`);
  }
  return parseChangeList(listJson, undefined);
};

const num = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/** `openspec list --json`; `base` holds the change folders the base has, or is undefined when it isn't known. */
export const parseChangeList = (
  list: Record<string, unknown>,
  base: Set<string> | undefined
): SpecChangeSummary[] =>
  (Array.isArray(list.changes) ? list.changes : [])
    .map(record)
    .filter(
      (c): c is Record<string, unknown> & { name: string } =>
        typeof c.name === "string"
    )
    .map((c) => ({
      completedTasks: num(c.completedTasks),
      isNew: base !== undefined && !base.has(c.name),
      ...(typeof c.lastModified === "string"
        ? { lastModified: c.lastModified }
        : {}),
      name: c.name,
      totalTasks: num(c.totalTasks),
    }));

/** `git ls-tree` of `openspec/changes/` on the base: the change folder names, without the archive. */
const baseChanges = (section: Section | undefined): Set<string> | undefined =>
  section?.code === 0
    ? new Set(
        section.text
          .split("\n")
          .map((l) => l.trim().replace(/^openspec\/changes\//u, ""))
          .filter((n) => n && n !== "archive")
      )
    : undefined;

/** `openspec status --json`: the artifacts, and whether every one implementing needs is done. */
export const parseStatus = (
  status: Record<string, unknown>
): { artifacts: SpecArtifact[]; planningComplete: boolean } => {
  const artifacts = (Array.isArray(status.artifacts) ? status.artifacts : [])
    .map(record)
    .filter((a) => typeof a.id === "string")
    .map((a) => {
      const missing = Array.isArray(a.missingDeps)
        ? a.missingDeps.filter((d): d is string => typeof d === "string")
        : [];
      return {
        id: String(a.id),
        outputPath: typeof a.outputPath === "string" ? a.outputPath : "",
        status: typeof a.status === "string" ? a.status : "unknown",
        ...(missing.length > 0 ? { missingDeps: missing } : {}),
      };
    });
  const requires = Array.isArray(status.applyRequires)
    ? status.applyRequires.filter((r): r is string => typeof r === "string")
    : undefined;
  const done = (id: string) =>
    artifacts.some((a) => a.id === id && a.status === "done");
  return {
    artifacts,
    planningComplete: requires
      ? requires.every(done)
      : status.isComplete === true,
  };
};

/** `openspec validate --json`: the change's item, its issues as text. */
export const parseValidation = (
  validate: Record<string, unknown>,
  change: string
): SpecChange["validation"] => {
  const items = (Array.isArray(validate.items) ? validate.items : []).map(
    record
  );
  const item = items.find((i) => i.id === change) ?? items[0];
  if (!item) {
    return { issues: ["openspec validate reported nothing"], valid: false };
  }
  const issues = (Array.isArray(item.issues) ? item.issues : []).map((raw) => {
    const issue = record(raw);
    const where =
      typeof issue.path === "string" && issue.path !== "file"
        ? `${issue.path}: `
        : "";
    return `${where}${typeof issue.message === "string" ? issue.message : JSON.stringify(raw)}`;
  });
  return { issues, valid: item.valid === true };
};

/** `openspec archive --json`: the folder the change went to, or why it didn't. */
export const parseArchive = (
  section: Section | undefined
): { archived: string } | { error: string } => {
  const json = sectionJson(section);
  const archived = record(json?.archive).archivedAs;
  if (section?.code === 0 && typeof archived === "string" && archived) {
    return { archived };
  }
  const messages = (Array.isArray(json?.status) ? json.status : [])
    .map(record)
    .filter((s) => s.severity === "error" && typeof s.message === "string")
    .map((s) => String(s.message));
  return {
    error: messages.length > 0 ? messages.join("; ") : lastLine(section),
  };
};

/** The change a view shows: the asked one, the only new one, else the most recently modified (new ones first). */
export const pickChange = (
  changes: SpecChangeSummary[],
  wanted: string | undefined,
  baseKnown: boolean
): string | undefined => {
  if (wanted && changes.some((c) => c.name === wanted)) {
    return wanted;
  }
  const candidates = baseKnown ? changes.filter((c) => c.isNew) : changes;
  return candidates.toSorted((a, b) =>
    (b.lastModified ?? "").localeCompare(a.lastModified ?? "")
  )[0]?.name;
};

export interface SpecsDeps {
  /** Validates the directory and finds its environment; throws for unknown projects and directories. */
  target: (projectId: ProjectId, directory: string) => CheckTarget;
  containers: Pick<Containers, "exec">;
  sessions: (projectId: ProjectId) => SessionSummary[];
  client: (
    envId: string
  ) => Pick<
    OpencodeClient,
    "session" | "updateSession" | "command" | "commands"
  >;
  /** Re-reads an environment's sessions after their metadata changed. */
  reconcile?: (envId: string) => void;
  log: (projectId: ProjectId, line: string) => void;
}

/** Reads a checkout's OpenSpec changes for the Spec view: the CLI runs in its container, the files are read here. */
export class Specs {
  private readonly deps: SpecsDeps;
  constructor(deps: SpecsDeps) {
    this.deps = deps;
  }

  async view(
    projectId: ProjectId,
    directory: string,
    change?: string
  ): Promise<SpecView> {
    if (change !== undefined && !CHANGE_NAME.test(change)) {
      throw new InvalidRequestError(`not an OpenSpec change name: ${change}`);
    }
    const target = this.deps.target(projectId, directory);
    const { host } = target.checkout;
    if (!host) {
      return {
        changes: [],
        unavailable: "the spec view isn't available on other nodes yet",
      };
    }
    if (target.unavailable) {
      return { changes: [], unavailable: target.unavailable };
    }
    const tasks = this.deps
      .sessions(projectId)
      .filter(
        (s) => s.directory === directory && s.task?.spec && !s.task.discarded
      );
    const spec = tasks.find((s) => s.task?.spec?.change)?.task?.spec;
    const wanted = change ?? spec?.change;
    // An archived change has left `openspec list`, so the CLI can't report on it.
    const archived = spec?.phase === "archived" && wanted === spec.change;

    let sections = await this.run(target, directory, {
      base: !target.isMain,
      change: archived ? undefined : wanted,
      list: true,
    });
    const list = sections.get("list");
    if (list?.code === NOT_FOUND) {
      return { changes: [], unavailable: NO_CLI };
    }
    const listJson = list?.code === 0 ? sectionJson(list) : undefined;
    if (!listJson) {
      return {
        changes: [],
        unavailable: `openspec list failed: ${lastLine(list)}`,
      };
    }
    const base = baseChanges(sections.get("base"));
    const changes = parseChangeList(listJson, base);
    if (wanted && !changes.some((c) => c.name === wanted)) {
      const folder = await archiveFolder(host, wanted, spec?.archived);
      if (folder) {
        return { changes, change: await archivedChange(host, wanted, folder) };
      }
    }
    const picked = pickChange(changes, wanted, base !== undefined);
    if (!picked) {
      return { changes };
    }
    if (picked !== wanted) {
      sections = await this.run(target, directory, { change: picked });
    }
    const fresh = changes.filter((c) => c.isNew);
    if (fresh.length === 1 && fresh[0].name === picked) {
      await this.record(projectId, tasks, picked);
    }
    return { changes, change: await this.change(host, picked, sections) };
  }

  /**
   * Sends review feedback on the checkout's change to its spec-first task as `/opsx-update <change>`, which revises
   * the planning artifacts without touching code. Only while the spec is proposed and the agent is between turns.
   */
  async revise(
    projectId: ProjectId,
    directory: string,
    change: string,
    feedback: string
  ): Promise<void> {
    if (!feedback.trim()) {
      throw new InvalidRequestError("the feedback is empty");
    }
    const { session, envId, client } = await this.proposed(
      projectId,
      directory,
      change,
      {
        busy: "the agent is still busy; send the comments when its turn ends",
        command: UPDATE_COMMAND,
        phase:
          "the spec is approved; it can only be revised while it's proposed",
      }
    );
    await client.command(
      session.id,
      UPDATE_COMMAND,
      `${change}\n\n${feedback.trim()}`,
      directory
    );
    this.deps.reconcile?.(envId);
  }

  /**
   * Approves the checkout's proposed change and starts implementing it: the task's phase becomes `implement`, then
   * its session runs `/opsx-apply <change>`. The CLI is asked again first, so the change must exist, have every
   * artifact implementing needs, and pass `openspec validate` unless `force` is set.
   */
  async approve(
    projectId: ProjectId,
    directory: string,
    change: string,
    force = false
  ): Promise<void> {
    const { session, envId, client, target } = await this.proposed(
      projectId,
      directory,
      change,
      {
        busy: "the agent is still busy; approve the spec when its turn ends",
        command: APPLY_COMMAND,
        phase: "the spec is already approved",
      }
    );
    const sections = await this.run(target, directory, { change, list: true });
    if (!listedChanges(sections).some((c) => c.name === change)) {
      throw new InvalidRequestError(`no OpenSpec change ${change} here`);
    }
    const statusJson = sectionJson(sections.get("status"));
    const { artifacts, planningComplete } = statusJson
      ? parseStatus(statusJson)
      : { artifacts: [], planningComplete: false };
    if (!planningComplete) {
      const missing = artifacts
        .filter((a) => a.status !== "done")
        .map((a) => a.id);
      throw new InvalidRequestError(
        missing.length > 0
          ? `the change isn't ready to implement: ${missing.join(", ")} not done`
          : "the change isn't ready to implement"
      );
    }
    const validateJson = sectionJson(sections.get("validate"));
    const validation = validateJson
      ? parseValidation(validateJson, change)
      : { issues: ["openspec validate failed"], valid: false };
    if (!validation.valid && !force) {
      throw new InvalidRequestError(
        `openspec validate finds problems: ${validation.issues.join("; ")}`
      );
    }

    const spec = session.task?.spec ?? { phase: "propose" as const };
    const raw = await client.session(session.id);
    const write = (phase: SpecPhase) =>
      client.updateSession(
        session.id,
        {
          metadata: patchTaskMetadata(raw.metadata, {
            spec: { ...spec, change, phase },
          }),
        },
        directory
      );
    // The phase changes first, so nothing can revise the spec while the agent implements it.
    await write("implement");
    try {
      await client.command(session.id, APPLY_COMMAND, change, directory);
    } catch (error) {
      await write("propose").catch(() => undefined);
      throw error;
    } finally {
      this.deps.reconcile?.(envId);
    }
    this.deps.log(
      projectId,
      `spec: approved ${change}, running /${APPLY_COMMAND}`
    );
  }

  /**
   * Archives the checkout's implemented change with the CLI, without an agent turn: `openspec archive` merges its
   * delta specs into `openspec/specs/` and moves it under `openspec/changes/archive/`, then the task's phase becomes
   * `archived`. Only once every task is done, since `--yes` archives an unfinished change too.
   */
  async archive(
    projectId: ProjectId,
    directory: string,
    change: string
  ): Promise<void> {
    const { session, envId, client, target } = this.task(
      projectId,
      directory,
      change,
      {
        busy: "the agent is still busy; archive the change when its turn ends",
        phase: (current) =>
          current === "archived"
            ? "the change is already archived"
            : "approve the spec and implement it before archiving it",
        wants: "implement",
      }
    );
    const summary = listedChanges(
      await this.run(target, directory, { list: true })
    ).find((c) => c.name === change);
    if (!summary) {
      throw new InvalidRequestError(`no OpenSpec change ${change} here`);
    }
    const { completedTasks: done, totalTasks: total } = summary;
    if (total === 0 || done < total) {
      throw new InvalidRequestError(
        `${done} of ${total} tasks are done; archive the change once they all are`
      );
    }
    const archived = await this.run(target, directory, {
      archive: true,
      change,
    });
    const result = parseArchive(archived.get("archive"));
    if ("error" in result) {
      throw new InvalidRequestError(`openspec archive failed: ${result.error}`);
    }
    this.deps.log(projectId, `spec: archived ${change} as ${result.archived}`);
    const spec = session.task?.spec ?? { phase: "implement" as const };
    try {
      const raw = await client.session(session.id);
      await client.updateSession(
        session.id,
        {
          metadata: patchTaskMetadata(raw.metadata, {
            spec: {
              ...spec,
              archived: result.archived,
              change,
              phase: "archived",
            },
          }),
        },
        directory
      );
    } finally {
      this.deps.reconcile?.(envId);
    }
  }

  /** The checkout's spec-first task, while its spec is proposed, its agent idle and opencode has `command`. */
  private async proposed(
    projectId: ProjectId,
    directory: string,
    change: string,
    refuse: { phase: string; busy: string; command: string }
  ) {
    const found = this.task(projectId, directory, change, {
      busy: refuse.busy,
      phase: () => refuse.phase,
      wants: "propose",
    });
    const commands = await found.client.commands(directory);
    if (!commands.some((c) => c.name === refuse.command)) {
      throw new UnavailableError(
        `opencode has no ${refuse.command} command here; run \`openspec update\` in the repository`
      );
    }
    return found;
  }

  /** The checkout's spec-first task, while it's in the `wants` phase and its agent is idle. */
  private task(
    projectId: ProjectId,
    directory: string,
    change: string,
    refuse: {
      wants: SpecPhase;
      phase: (current: SpecPhase | undefined) => string;
      busy: string;
    }
  ) {
    if (!CHANGE_NAME.test(change)) {
      throw new InvalidRequestError(`not an OpenSpec change name: ${change}`);
    }
    const target = this.deps.target(projectId, directory);
    const session = this.deps
      .sessions(projectId)
      .find(
        (s) => s.directory === directory && s.task?.spec && !s.task.discarded
      );
    if (!session) {
      throw new InvalidRequestError(`no spec-first task works in ${directory}`);
    }
    const current = session.task?.spec?.phase;
    if (current !== refuse.wants) {
      throw new InvalidRequestError(refuse.phase(current));
    }
    if (session.status !== "idle") {
      throw new BusyError(session.id, refuse.busy);
    }
    const envId = session.envId ?? projectId;
    return { client: this.deps.client(envId), envId, session, target };
  }

  private async run(
    target: CheckTarget,
    directory: string,
    opts: { list?: boolean; base?: boolean; change?: string; archive?: boolean }
  ): Promise<Map<string, Section>> {
    const r = await this.deps.containers.exec(
      target.exec,
      [
        "sh",
        "-c",
        SPEC_SCRIPT,
        "sh",
        directory,
        opts.list ? "list" : "",
        opts.base ? "base" : "",
        opts.change ?? "",
        opts.archive ? "archive" : "",
      ],
      { timeoutMs: EXEC_TIMEOUT_MS }
    );
    if (r.exitCode === 125) {
      throw new InvalidRequestError(
        `${directory} doesn't exist in the container`
      );
    }
    return parseSections(r.stdout);
  }

  private async change(
    host: string,
    name: string,
    sections: Map<string, Section>
  ): Promise<SpecChange> {
    const statusJson = sectionJson(sections.get("status"));
    const validateJson = sectionJson(sections.get("validate"));
    const { artifacts, planningComplete } = statusJson
      ? parseStatus(statusJson)
      : { artifacts: [], planningComplete: false };
    const documents = await readDocuments(
      path.join(host, "openspec", "changes", name)
    );
    const perCapability = await Promise.all(
      deltaSpecs(documents).map(({ capability, content }) =>
        readText(mainSpec(host, capability)).then((current) =>
          requirementChanges(capability, content, current)
        )
      )
    );
    const requirements = perCapability.flat();
    return {
      artifacts,
      documents,
      name,
      planningComplete,
      requirements,
      validation: validateJson
        ? parseValidation(validateJson, name)
        : {
            issues: [
              `openspec validate failed: ${lastLine(sections.get("validate"))}`,
            ],
            valid: false,
          },
    };
  }

  /** Records the change on the task's sessions in this checkout, so later views and phases know it. */
  private async record(
    projectId: ProjectId,
    tasks: SessionSummary[],
    change: string
  ): Promise<void> {
    const envs = new Set<string>();
    for (const s of tasks) {
      const spec = s.task?.spec;
      if (!spec || spec.change === change) {
        continue;
      }
      const envId = s.envId ?? projectId;
      try {
        const client = this.deps.client(envId);
        const raw = await client.session(s.id);
        await client.updateSession(
          s.id,
          {
            metadata: patchTaskMetadata(raw.metadata, {
              spec: { ...spec, change },
            }),
          },
          s.directory
        );
        envs.add(envId);
      } catch (error) {
        this.deps.log(
          projectId,
          `spec: could not record change ${change} on ${s.title}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    for (const envId of envs) {
      this.deps.reconcile?.(envId);
    }
  }
}

const readText = (file: string): Promise<string | undefined> =>
  fs.readFile(file, "utf-8").catch(() => undefined);

/** The change folder's markdown, paths relative to it with `/`; proposal, design and tasks first. */
const readDocuments = async (
  dir: string
): Promise<{ path: string; content: string }[]> => {
  const entries = await fs
    .readdir(dir, { recursive: true, withFileTypes: true })
    .catch(() => []);
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) =>
      path
        .relative(dir, path.join(e.parentPath, e.name))
        .split(path.sep)
        .join("/")
    )
    .toSorted((a, b) => docRank(a) - docRank(b) || a.localeCompare(b))
    .slice(0, MAX_DOCUMENTS);
  const documents = await Promise.all(
    files.map(async (file) => {
      const full = path.join(dir, file);
      const stat = await fs.stat(full).catch(() => undefined);
      if (!stat || stat.size > MAX_DOCUMENT_BYTES) {
        return { content: `_${file} is too large to show here._`, path: file };
      }
      return { content: (await readText(full)) ?? "", path: file };
    })
  );
  return documents;
};

const DOC_ORDER = ["proposal.md", "design.md", "tasks.md"];
const docRank = (file: string): number => {
  const i = DOC_ORDER.indexOf(file);
  return i === -1 ? DOC_ORDER.length : i;
};

/** The capabilities a change's delta specs touch, with each delta's markdown. */
const deltaSpecs = (
  documents: { path: string; content: string }[]
): { capability: string; content: string }[] =>
  documents.flatMap((d) => {
    const capability = DELTA_SPEC.exec(d.path)?.groups?.cap;
    return capability ? [{ capability, content: d.content }] : [];
  });

const mainSpec = (host: string, capability: string): string =>
  path.join(host, "openspec", "specs", capability, "spec.md");

const archiveDir = (host: string): string =>
  path.join(host, "openspec", "changes", "archive");

/** The change's folder in the archive: the recorded one, else the newest `<date>-<change>`. */
const archiveFolder = async (
  host: string,
  change: string,
  recorded: string | undefined
): Promise<string | undefined> => {
  const names = await fs.readdir(archiveDir(host)).catch((): string[] => []);
  if (recorded && names.includes(recorded)) {
    return recorded;
  }
  return names
    .filter(
      (n) => ARCHIVED_DATE.test(n) && n.replace(ARCHIVED_DATE, "") === change
    )
    .toSorted()
    .at(-1);
};

/**
 * An archived change, read from the archive. Its deltas are already merged into the main specs, so requirements show
 * without a before, and the specs it updated come as they are now.
 */
const archivedChange = async (
  host: string,
  name: string,
  folder: string
): Promise<SpecChange> => {
  const documents = await readDocuments(path.join(archiveDir(host), folder));
  const deltas = deltaSpecs(documents);
  const updatedSpecs = await Promise.all(
    deltas.map(async ({ capability }) => ({
      content: (await readText(mainSpec(host, capability))) ?? "",
      path: `${capability}/spec.md`,
    }))
  );
  return {
    archived: folder,
    artifacts: [],
    documents,
    name,
    planningComplete: true,
    requirements: deltas.flatMap(({ capability, content }) =>
      requirementChanges(capability, content, undefined)
    ),
    updatedSpecs,
    validation: { issues: [], valid: true },
  };
};
