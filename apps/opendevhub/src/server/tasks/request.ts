import { JIRA_KEY } from "../../shared/jira";
import type { JiraTaskSource } from "../../shared/jira";
import { MAX_VARIANTS } from "../../shared/tasks";
import type {
  ModelRef,
  ModelsInfo,
  SpecPhase,
  TaskMeta,
  TaskRequest,
  TaskSpec,
  TaskVariantSpec,
} from "../../shared/types";
import { InvalidRequestError, validateBranch } from "../git/worktrees";
import { jiraUrl } from "../integrations/jira";
import type { RawAgent, RawModel } from "../opencode/client";

const PROMPT_MAX = 100_000;
const TITLE_LIMIT = 200;
/** Provider ids, model ids, model variants and agent names. */
const NAME = /^[A-Za-z0-9._:/@-]{1,200}$/u;

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const parseModel = (value: unknown, n: number): ModelRef | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const o = (typeof value === "object" ? value : {}) as Record<string, unknown>;
  const id = str(o.id);
  const providerID = str(o.providerID);
  const variant = str(o.variant);
  if (
    !id ||
    !providerID ||
    !NAME.test(id) ||
    !NAME.test(providerID) ||
    (variant !== undefined && !NAME.test(variant))
  ) {
    throw new InvalidRequestError(
      `variant ${n}: model needs an id and a providerID`
    );
  }
  return { id, providerID, ...(variant ? { variant } : {}) };
};

const parseVariant = (value: unknown, n: number): TaskVariantSpec => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRequestError(`variant ${n} must be an object`);
  }
  const o = value as Record<string, unknown>;
  const model = parseModel(o.model, n);
  const agent = str(o.agent)?.trim();
  if (
    o.agent !== undefined &&
    o.agent !== null &&
    o.agent !== "" &&
    (!agent || !NAME.test(agent))
  ) {
    throw new InvalidRequestError(`variant ${n}: invalid agent`);
  }
  return { ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
};

/** Copy only the ticket snapshot fields; never accept credentials or remote HTML. */
export const parseJiraTaskSource = (value: unknown): JiraTaskSource => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRequestError("invalid Jira ticket reference");
  }
  const v = value as Record<string, unknown>;
  if (
    typeof v.key !== "string" ||
    v.key.length > 200 ||
    !JIRA_KEY.test(v.key) ||
    typeof v.instanceUrl !== "string" ||
    typeof v.title !== "string" ||
    v.title.length > 1000 ||
    typeof v.description !== "string" ||
    v.description.length > PROMPT_MAX
  ) {
    throw new InvalidRequestError("invalid Jira ticket reference");
  }
  return {
    description: v.description,
    instanceUrl: jiraUrl(v.instanceUrl),
    key: v.key,
    title: v.title,
  };
};

/** Validates `POST …/tasks`; unknown fields are ignored. */
export const parseTaskRequest = (
  body: Record<string, unknown>
): TaskRequest => {
  const jira =
    body.jira === undefined ? undefined : parseJiraTaskSource(body.jira);
  const prompt = str(body.prompt)?.trim() ?? "";
  if (!prompt) {
    throw new InvalidRequestError("the prompt is empty");
  }
  if (prompt.length > PROMPT_MAX) {
    throw new InvalidRequestError(
      `the prompt is longer than ${PROMPT_MAX} characters`
    );
  }
  const title = str(body.title)?.trim() || undefined;
  if (title && title.length > TITLE_LIMIT) {
    throw new InvalidRequestError(
      `the title must be at most ${TITLE_LIMIT} characters`
    );
  }
  const where = body.where ?? "worktree";
  if (where !== "worktree" && where !== "workspace") {
    throw new InvalidRequestError(`invalid where "${String(where)}"`);
  }
  const environment = body.environment ?? undefined;
  if (
    environment !== undefined &&
    environment !== "shared" &&
    environment !== "isolated"
  ) {
    throw new InvalidRequestError(
      `invalid environment "${String(environment)}"`
    );
  }
  const rawNode = str(body.node)?.trim() || undefined;
  if (
    rawNode !== undefined &&
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(rawNode)
  ) {
    throw new InvalidRequestError(`invalid node "${rawNode}"`);
  }
  const node = rawNode === "local" ? undefined : rawNode;
  const rawBranch = str(body.branch);
  const branch = rawBranch?.trim() ? validateBranch(rawBranch) : undefined;
  const rawBase = str(body.base);
  const base = rawBase?.trim() ? validateBranch(rawBase) : undefined;
  const raw =
    body.variants === undefined || body.variants === null
      ? [{}]
      : body.variants;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_VARIANTS) {
    throw new InvalidRequestError(
      `variants must be a list of 1 to ${MAX_VARIANTS}`
    );
  }
  const variants = raw.map((v, i) => parseVariant(v, i + 1));
  if (body.spec !== undefined && typeof body.spec !== "boolean") {
    throw new InvalidRequestError("spec must be true or false");
  }
  const spec = body.spec === true ? { phase: "propose" as const } : undefined;
  if (where === "workspace") {
    if (environment === "isolated") {
      throw new InvalidRequestError(
        "only a new worktree can get its own container"
      );
    }
    if (variants.length > 1) {
      throw new InvalidRequestError(
        "several variants need a worktree each; choose New worktree"
      );
    }
    if (branch || base) {
      throw new InvalidRequestError(
        "branch and base only apply to a new worktree"
      );
    }
  }
  return {
    prompt,
    ...(jira ? { jira } : {}),
    ...(title ? { title } : {}),
    where,
    ...(environment ? { environment } : {}),
    ...(node ? { node } : {}),
    ...(branch ? { branch } : {}),
    ...(base ? { base } : {}),
    ...(spec ? { spec } : {}),
    variants,
  };
};

const SPEC_PHASES = new Set<string>(["propose", "implement", "archived"]);

/** A spec-first task's phase; tasks from before phases wrote `spec: true`, which meant proposing. */
const parseTaskSpec = (spec: unknown): TaskSpec | undefined => {
  if (spec === true) {
    return { phase: "propose" };
  }
  if (!spec || typeof spec !== "object") {
    return undefined;
  }
  const { phase, change, archived, proposedIn, implementedIn } = spec as Record<
    string,
    unknown
  >;
  if (typeof phase !== "string" || !SPEC_PHASES.has(phase)) {
    return undefined;
  }
  const taskId = (value: unknown) =>
    typeof value === "string" && value.startsWith("tsk_") ? value : undefined;
  const from = taskId(proposedIn);
  const to = taskId(implementedIn);
  return {
    phase: phase as SpecPhase,
    ...(typeof change === "string" && change ? { change } : {}),
    ...(typeof archived === "string" && archived ? { archived } : {}),
    ...(from ? { proposedIn: from } : {}),
    ...(to ? { implementedIn: to } : {}),
  };
};

/** The task a session belongs to, from `metadata.opendevhub`; undefined when it has none or it is malformed. */
export const parseTaskMeta = (metadata: unknown): TaskMeta | undefined => {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const m = (metadata as { opendevhub?: unknown }).opendevhub;
  if (!m || typeof m !== "object") {
    return undefined;
  }
  const {
    task,
    variant,
    of,
    title,
    branch,
    discarded,
    jira: rawJira,
    spec,
  } = m as Record<string, unknown>;
  if (typeof task !== "string" || !task.startsWith("tsk_")) {
    return undefined;
  }
  if (
    typeof variant !== "number" ||
    typeof of !== "number" ||
    !Number.isInteger(variant) ||
    !Number.isInteger(of)
  ) {
    return undefined;
  }
  if (variant < 1 || of < variant) {
    return undefined;
  }
  let jira: JiraTaskSource | undefined;
  try {
    if (rawJira !== undefined) {
      jira = parseJiraTaskSource(rawJira);
    }
  } catch {
    /* Keep older task metadata usable. */
  }
  const taskSpec = parseTaskSpec(spec);
  return {
    task,
    variant,
    of,
    ...(jira ? { jira } : {}),
    title: typeof title === "string" ? title : "",
    ...(typeof branch === "string" ? { branch } : {}),
    ...(taskSpec ? { spec: taskSpec } : {}),
    ...(discarded === true ? { discarded: true } : {}),
  };
};

/** The session's metadata with `patch` merged into `opendevhub`. opencode's PATCH replaces metadata, so keep every key. */
export const patchTaskMetadata = (
  metadata: Record<string, unknown> | undefined,
  patch: Partial<TaskMeta>
): Record<string, unknown> => {
  const own = metadata?.opendevhub;
  return {
    ...metadata,
    opendevhub: {
      ...(own && typeof own === "object" ? own : {}),
      ...patch,
    },
  };
};

/** The session's metadata with `opendevhub.discarded` set. */
export const discardMetadata = (
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> => patchTaskMetadata(metadata, { discarded: true });

/** What the New task dialog may show. Copies named fields only: opencode's model info holds API keys. */
export const toModelsInfo = (
  models: RawModel[],
  def: RawModel | undefined,
  agents: RawAgent[]
): ModelsInfo => ({
  models: models
    .filter((m) => m.enabled !== false && m.status !== "deprecated")
    .map((m) => ({
      id: m.id,
      name: m.name || m.id,
      providerID: m.providerID,
      variants: (m.variants ?? [])
        .map((v) => v.id)
        .filter((v): v is string => typeof v === "string"),
    })),
  ...(def ? { default: { id: def.id, providerID: def.providerID } } : {}),
  agents: agents
    .filter((a) => a.mode !== "subagent" && !a.hidden)
    .map((a) => ({
      id: a.id,
      name: a.name || a.id,
      ...(a.description ? { description: a.description } : {}),
    })),
});
