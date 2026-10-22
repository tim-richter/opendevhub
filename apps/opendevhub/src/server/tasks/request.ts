import { JIRA_KEY } from "../../shared/jira";
import type { JiraTaskSource } from "../../shared/jira";
import { MAX_VARIANTS } from "../../shared/tasks";
import { ATTACHMENTS_MAX } from "../../shared/types";
import type {
  ComposerAttachment,
  ComposerMention,
  ComposerSendRequest,
  ModelRef,
  ModelsInfo,
  TaskRequest,
  TaskStartSpec,
  TaskVariantSpec,
} from "../../shared/types";
import { InvalidRequestError, validateBranch } from "../git/worktrees";
import { jiraUrl } from "../integrations/jira";
import type { RawAgent, RawModel } from "../opencode/client";
import { hubCommandOf } from "../sessions/message";

const PROMPT_MAX = 100_000;
export const TITLE_LIMIT = 200;
/** Provider ids, model ids, model variants and agent names. */
const NAME = /^[A-Za-z0-9._:/@-]{1,200}$/u;

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const parseModel = (value: unknown, what: string): ModelRef | undefined => {
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
      `${what}: model needs an id and a providerID`
    );
  }
  return { id, providerID, ...(variant ? { variant } : {}) };
};

const parseVariant = (value: unknown, n: number): TaskVariantSpec => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRequestError(`variant ${n} must be an object`);
  }
  const o = value as Record<string, unknown>;
  const model = parseModel(o.model, `variant ${n}`);
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

const MENTIONS_MAX = 100;

const parseMention = (value: unknown): ComposerMention => {
  const o = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const { kind, start, end, name } = o;
  if (
    (kind !== "file" && kind !== "agent") ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    typeof name !== "string" ||
    !name
  ) {
    throw new InvalidRequestError("invalid mention in the message");
  }
  return { end: end as number, kind, name, start: start as number };
};

/** An uploaded file's shape; `attachmentsOf` checks its `data:` URL when the message is resolved. */
const parseAttachment = (value: unknown): ComposerAttachment => {
  const o = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const name = str(o.name);
  const url = str(o.url);
  if (!name || name.length > 255 || !url?.startsWith("data:")) {
    throw new InvalidRequestError("invalid attachment in the message");
  }
  return { name, url };
};

/** A composer message as a task's first turn; the hub's own commands need a conversation already. */
export const parseFirstMessage = (value: unknown): ComposerSendRequest => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRequestError("message must be an object");
  }
  const o = value as Record<string, unknown>;
  const text = str(o.text) ?? "";
  if (!text.trim()) {
    throw new InvalidRequestError("the message is empty");
  }
  const hub = hubCommandOf(text);
  if (hub) {
    throw new InvalidRequestError(
      `/${hub} needs a conversation; it can't start one`
    );
  }
  const raw = o.mentions ?? [];
  if (!Array.isArray(raw) || raw.length > MENTIONS_MAX) {
    throw new InvalidRequestError(
      `mentions must be a list of at most ${MENTIONS_MAX}`
    );
  }
  const mentions = raw.map(parseMention);
  const files = o.attachments ?? [];
  if (!Array.isArray(files) || files.length > ATTACHMENTS_MAX) {
    throw new InvalidRequestError(
      `attachments must be a list of at most ${ATTACHMENTS_MAX}`
    );
  }
  const attachments = files.map(parseAttachment);
  const model = parseModel(o.model, "the message");
  return {
    text,
    ...(mentions.length > 0 ? { mentions } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(model ? { model } : {}),
  };
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

/** Validates `POST …/tasks`; unknown fields are ignored. A draft may leave the prompt empty when it has a title. */
export const parseTaskRequest = (
  body: Record<string, unknown>,
  options: { draft?: boolean } = {}
): TaskRequest => {
  const jira =
    body.jira === undefined ? undefined : parseJiraTaskSource(body.jira);
  const prompt = str(body.prompt)?.trim() ?? "";
  if (!prompt && !(options.draft && str(body.title)?.trim())) {
    throw new InvalidRequestError(
      options.draft ? "a draft needs a title or a brief" : "the prompt is empty"
    );
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
  if (where !== "worktree" && where !== "workspace" && where !== "existing") {
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
  const directory = str(body.directory)?.trim();
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
  const spec = parseSpecStart(body.spec);
  const message =
    body.message === undefined ? undefined : parseFirstMessage(body.message);
  if (message && spec) {
    throw new InvalidRequestError(
      "a spec-first task starts with opsx-propose, not a message"
    );
  }
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
  if (where === "existing") {
    if (!directory) {
      throw new InvalidRequestError("choose an existing worktree");
    }
    if (variants.length > 1) {
      throw new InvalidRequestError(
        "several variants need a new worktree each"
      );
    }
    if (branch || base) {
      throw new InvalidRequestError(
        "branch and base only apply to a new worktree"
      );
    }
    if (node) {
      throw new InvalidRequestError(
        "an existing worktree must run on this machine"
      );
    }
  } else if (directory !== undefined) {
    throw new InvalidRequestError(
      "directory only applies to an existing worktree"
    );
  }
  return {
    prompt,
    ...(jira ? { jira } : {}),
    ...(title ? { title } : {}),
    where,
    ...(directory ? { directory } : {}),
    ...(environment ? { environment } : {}),
    ...(node ? { node } : {}),
    ...(branch ? { branch } : {}),
    ...(base ? { base } : {}),
    ...(spec ? { spec } : {}),
    ...(message ? { message } : {}),
    variants,
  };
};

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

/** A new task's `spec`: `true` or `propose` proposes first, `explore` explores first. */
const parseSpecStart = (raw: unknown): TaskStartSpec | undefined => {
  if (raw === undefined || raw === false) {
    return undefined;
  }
  if (raw === true || raw === "propose") {
    return { phase: "propose" };
  }
  if (raw === "explore") {
    return { explore: true, phase: "propose" };
  }
  throw new InvalidRequestError(
    'spec must be "propose", "explore", true or false'
  );
};
