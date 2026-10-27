import { validator } from "hono/validator";
import { z } from "zod";

import { MAX_ACTIVITY_PAGE_SIZE, OBJECT_TYPES } from "../../shared/activity";
import {
  JIRA_JQL_MAX,
  JIRA_KEY,
  JIRA_PROJECT_KEY,
  JIRA_SCOPES,
  JIRA_SORTS,
  JIRA_STATUSES,
  normalizeJql,
} from "../../shared/jira";
import {
  DOTFILES_REPOSITORY,
  FEATURE_ID,
  FEATURE_ID_MAX,
  FEATURES_MAX,
  MOUNTS_MAX,
  mountError,
  SETUP_COMMAND_MAX,
} from "../../shared/personalization";
import {
  PROJECT_COLORS,
  PROJECT_SHORT_NAME,
} from "../../shared/project-appearance";
import { STACK_IDS } from "../../shared/stacks";
import { ATTACHMENTS_MAX } from "../../shared/types";
import { parseCleanupItems } from "../git/cleanup";
import { errorResponse } from "./helpers";

/** Shape validation at the HTTP boundary; domain modules retain their semantic checks and defaults. */
export const validateJson = <T>(schema: z.ZodType<T>) =>
  validator("json", (value, c) => {
    try {
      const result = schema.safeParse(value);
      if (!result.success) {
        return c.json({ error: "Invalid request body." }, 400);
      }
      return result.data;
    } catch (error) {
      return errorResponse(c, error);
    }
  });

export const validateQuery = <T>(schema: z.ZodType<T>) =>
  validator("query", (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      return c.json({ error: "Invalid query parameters." }, 400);
    }
    return result.data;
  });

const text = z.string().optional();
const webUrl = z
  .string()
  .max(2000)
  .refine((value) => /^https?:\/\//iu.test(value) && URL.canParse(value));
const flag = z.boolean().optional();
// Only literal true enables these options; preserve the existing conservative coercion.
const actionFlag = z
  .unknown()
  .transform((value) => value === true)
  .optional();
const directory = z.object({ directory: text });
/** Where a shareable project setting is saved; the user's own config.json unless `team`. */
const scope = z.enum(["team", "personal"]).optional();
const personalization = z.object({
  features: z
    .record(
      z.string().max(FEATURE_ID_MAX).regex(FEATURE_ID),
      z.record(z.string(), z.unknown())
    )
    .refine((f) => Object.keys(f).length <= FEATURES_MAX),
  setupCommand: z.string().max(SETUP_COMMAND_MAX).optional(),
  dotfiles: z
    .object({
      repository: z.string().max(500).regex(DOTFILES_REPOSITORY),
      installCommand: z.string().max(2000).optional(),
      targetPath: z.string().max(500).optional(),
    })
    .optional(),
  mounts: z
    .array(
      z
        .object({
          source: z.string().max(1000),
          target: z.string().max(1000),
          type: z.enum(["bind", "volume"]),
        })
        .refine((m) => mountError(m) === undefined)
    )
    .max(MOUNTS_MAX)
    .optional(),
});
// Provider ids, model ids and variants, as `tasks/request.ts` takes them.
const modelName = z.string().regex(/^[A-Za-z0-9._:/@-]{1,200}$/u);
const modelRef = z.object({
  id: modelName,
  providerID: modelName,
  variant: modelName.optional(),
});
const composerSend = z.object({
  text: z.string().max(100_000),
  mentions: z
    .array(
      z.object({
        kind: z.enum(["file", "agent"]),
        start: z.number().int().min(0),
        end: z.number().int().min(0),
        name: z.string().min(1).max(4096),
      })
    )
    .max(100)
    .optional(),
  attachments: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        // The base64 of the largest file opencode takes, and its `data:<mime>;base64,` prefix.
        url: z.string().startsWith("data:").max(28_000_000),
      })
    )
    .max(ATTACHMENTS_MAX)
    .optional(),
  model: modelRef.optional(),
  agent: modelName.optional(),
});
const aiReview = z.object({
  projectId: z.string(),
  directory: z.string(),
  commitId: z.string(),
  runId: z
    .string()
    .regex(/^[a-z0-9-]{1,100}$/u)
    .optional(),
});
const ocrProvider = z.object({
  preset: z.string().max(100),
  url: z.string().max(2000),
  protocol: z.enum(["", "anthropic", "openai", "openai-responses"]),
  model: z.string().max(200),
  key: z.string().max(4096).optional(),
  clearKey: flag,
});
const ocrLimits = z.object({
  concurrency: z.number(),
  fileTimeout: z.number(),
  tokenBudget: z.number(),
  runLimit: z.number(),
});
const strings = z
  .array(z.unknown())
  .transform((values) =>
    values.filter((value): value is string => typeof value === "string")
  )
  .optional();

const variants = z.array(
  z.object({
    agent: text,
    model: z
      .object({ id: z.string(), providerID: z.string(), variant: text })
      .optional(),
  })
);

const presetFilters = z.object({
  inbox: z.enum(["authored", "review-requested", "assigned", "review"]),
  state: z.enum(["all", "open", "closed"]),
  q: z.string().max(200).optional(),
  repository: z.string().max(200).optional(),
  org: z.string().max(200).optional(),
  team: z.string().max(200).optional(),
  authors: z
    .array(z.string().regex(/^[\w.-]{1,40}$/u))
    .max(20)
    .optional(),
});
const presetName = z.string().trim().min(1).max(80);
const todoText = z.string().trim().min(1).max(500);

/** Raw JQL, kept on one line; it is passed to Jira as written. */
const jql = z.string().max(JIRA_JQL_MAX).transform(normalizeJql);

const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/** A Tickets page view: a board or filter goes with its own scope only. */
const jiraPresetFilters = z
  .object({
    scope: z.enum(JIRA_SCOPES),
    board: id.optional(),
    sprint: z.boolean().optional(),
    filter: id.optional(),
    project: z.string().max(100).regex(JIRA_PROJECT_KEY).optional(),
    status: z.enum(JIRA_STATUSES),
    sort: z.enum(JIRA_SORTS),
    search: z.string().max(500),
    jql: jql.optional(),
  })
  .refine(
    (f) =>
      (f.scope === "board") === (f.board !== undefined) &&
      (f.scope === "filter") === (f.filter !== undefined) &&
      (!f.sprint || f.scope === "board"),
    "The view's board, filter or sprint does not fit its scope."
  );

export const bodies = {
  forgejoPreset: z.object({ name: presetName, filters: presetFilters }),
  forgejoPresetUpdate: z.object({
    name: presetName.optional(),
    filters: presetFilters.optional(),
  }),
  jiraPreset: z.object({ name: presetName, filters: jiraPresetFilters }),
  jiraPresetUpdate: z.object({
    name: presetName.optional(),
    filters: jiraPresetFilters.optional(),
  }),
  integration: z.object({
    enabled: z.boolean(),
    url: text,
    token: text,
    clearToken: flag,
  }),
  connection: z.object({ url: z.string(), token: text }),
  forgejoReview: z.object({
    commitId: z.string(),
    body: z.string(),
    event: z.enum(["COMMENT", "APPROVED", "REQUEST_CHANGES"]),
    comments: z.array(
      z.object({
        path: z.string(),
        body: z.string(),
        old_position: z.number(),
        new_position: z.number(),
      })
    ),
  }),
  aiReview,
  aiFindings: aiReview.extend({ sessionId: text }),
  localAiReview: z.object({
    directory: z.string(),
    mode: z.enum(["working", "branch"]),
    base: text,
    runId: z
      .string()
      .regex(/^[a-z0-9-]{1,100}$/u)
      .optional(),
    /** The conversation the review page sends to; a task's starts the review in that task. */
    sessionId: text,
  }),
  localAiFindings: z.object({ directory: z.string(), sessionId: z.string() }),
  ocrSettings: z.object({ provider: ocrProvider, limits: ocrLimits }),
  personalization,
  preferences: z.object({ updateBaseBeforeTask: z.boolean() }),
  basePull: z.object({
    base: z.string().max(250).optional(),
    branch: z.string().max(250).optional(),
  }),
  projectPersonalization: personalization.extend({
    inheritGlobal: z.boolean(),
  }),
  ocrProject: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("global") }),
    ocrProvider.extend({ mode: z.literal("custom") }),
  ]),
  ocrTest: z.object({
    provider: ocrProvider,
    projectId: z.string().max(200).optional(),
  }),
  ocrInstall: z.object({ projectId: z.string(), directory: z.string() }),
  forgejoWorktree: z.object({
    projectId: z.string(),
    commitId: z.string(),
  }),
  roots: z.object({ roots: z.array(z.string()) }),
  projectName: z.object({ name: z.string().max(200), scope }),
  projectAppearance: z.object({
    shortName: z.union([z.literal(""), z.string().regex(PROJECT_SHORT_NAME)]),
    color: z.union([z.literal(""), z.enum(PROJECT_COLORS)]),
    scope,
  }),
  todo: z.object({ text: todoText }),
  todoUpdate: z.object({ text: todoText.optional(), done: flag }),
  savedPermission: z
    .object({
      action: z.string().trim().min(1).max(200).optional(),
      resource: z.string().trim().min(1).max(2000).optional(),
    })
    .refine((b) => b.action !== undefined || b.resource !== undefined, {
      message: "give an action or a resource",
    }),
  projectPorts: z.object({
    ports: z.array(z.number().int().min(1).max(65_535)).max(100),
    scope,
  }),
  projectHostPorts: z.object({
    ports: z.array(z.number().int().min(1).max(65_535)).max(100),
  }),
  projectLinks: z.object({
    forgejoRepository: z
      .string()
      .regex(
        /^[\w.-]{1,100}\/[\w.-]{1,100}$/u,
        "Enter a repository as owner/name."
      )
      .optional(),
    jiraBoard: z
      .object({
        id,
        name: z.string().min(1).max(200),
      })
      .optional(),
    jiraJql: jql.optional(),
    scope,
  }),
  sshTest: z.object({ host: z.string().min(1) }),
  onboarding: z.object({ path: text, stack: z.enum(STACK_IDS) }),
  cleanup: z
    .object({ items: z.unknown() })
    .transform(({ items }) => ({ items: parseCleanupItems(items) })),
  node: z.object({ ssh: z.string(), label: text }),
  subscription: z.object({
    endpoint: text,
    origin: z.string().optional(),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: text, auth: text }).optional(),
  }),
  unsubscribe: z.object({ endpoint: text }),
  pushTest: z.object({ endpoint: z.string().min(1) }),
  worktree: z.object({
    branch: text,
    base: text,
    prompt: text,
    startSession: actionFlag,
  }),
  removeWorktree: z.object({
    path: text,
    force: actionFlag,
    deleteBranch: actionFlag,
  }),
  environment: z.object({ path: text }),
  configApproval: z.object({
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  session: directory.extend({ title: text, prompt: text }),
  prompt: z.object({ text }),
  composerSend,
  chat: z.object({
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("worktree") }),
      z.object({ kind: z.literal("checkout"), directory: z.string().min(1) }),
    ]),
    message: composerSend,
  }),
  editor: directory.extend({ editor: text }),
  task: z.object({
    prompt: z.string(),
    title: text,
    where: z.enum(["worktree", "workspace", "existing"]).optional(),
    directory: text,
    branch: text,
    base: text,
    environment: z.enum(["shared", "isolated"]).optional(),
    node: text,
    spec: z.union([z.boolean(), z.enum(["propose", "explore"])]).optional(),
    jira: z
      .object({
        key: z.string(),
        instanceUrl: z.string(),
        title: z.string(),
        description: z.string(),
      })
      .optional(),
    variants: variants.optional(),
  }),
  pick: z.object({ sessionId: text, removeWorktrees: actionFlag }),
  draftFromTicket: z.object({
    jira: z.object({
      key: z.string(),
      instanceUrl: z.string(),
      title: z.string(),
      description: z.string(),
    }),
  }),
  makeTask: z.object({
    title: z.string().max(200),
    brief: z.string().max(100_000),
    ticket: z
      .object({
        key: z.string(),
        instanceUrl: z.string(),
        title: z.string(),
        description: z.string(),
      })
      .optional(),
    pullRequest: z.string().max(2000).optional(),
    spec: flag,
    variants: variants.max(8).optional(),
  }),
  permission: z.object({
    decision: z.enum(["once", "always", "reject"]),
    message: text,
  }),
  form: z.object({
    answer: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.array(z.string())])
    ),
  }),
  directory,
  commit: directory.extend({ message: text }),
  stage: directory.extend({
    action: z.enum(["stage", "unstage", "discard"]),
    file: z.string().max(1000).optional(),
    hunk: z.number().int().min(0).optional(),
    paths: z.array(z.string().max(1000)).max(500).optional(),
  }),
  update: directory.extend({ base: text }),
  merge: directory.extend({ base: text, ffOnly: actionFlag }),
  publish: directory.extend({
    base: text,
    remote: text,
    strategy: z.enum(["branch", "agit"]),
    title: text,
    description: text,
  }),
  checks: z.object({
    checks: z
      .array(
        z.object({
          name: z.string(),
          command: z.string().optional(),
          where: z.enum(["host", "container"]).optional(),
          timeout: z.number().optional(),
          group: z.string().optional(),
          disabled: z.literal(true).optional(),
        })
      )
      .nullable(),
    scope,
  }),
  runChecks: directory.extend({ names: strings, approve: strings }),
  cancelCheck: directory.extend({ name: z.string().optional() }),
  reviseSpec: directory.extend({
    change: z.string(),
    feedback: z.string(),
    session: z.string().optional(),
  }),
  approveSpec: directory.extend({
    newConversation: z.boolean().optional(),
    change: z.string(),
    force: z.boolean().optional(),
    session: z.string().optional(),
  }),
  archiveSpec: directory.extend({
    change: z.string(),
    session: z.string().optional(),
  }),
  implementSpec: directory.extend({
    change: z.string(),
    session: z.string().optional(),
    variants,
    force: z.boolean().optional(),
  }),
};

const page = z.object({ page: text });
/** A positive whole number, as a query string carries it. */
const count = z.string().regex(/^[1-9]\d{0,15}$/u);
/** `<type>:<id>`, e.g. `worktree:12` or `variant:tsk_…/2`. */
const entity = z
  .string()
  .max(500)
  .regex(new RegExp(`^(?:${OBJECT_TYPES.join("|")}):.+$`, "u"));
const review = directory.extend({
  base: text,
  file: text,
  from: text,
  mode: z.enum(["working", "branch", "turn"]).optional(),
  session: text,
});
export const queries = {
  page,
  pulls: page.extend({
    state: z.enum(["all", "open", "closed"]).optional(),
    inbox: z
      .enum(["authored", "review-requested", "assigned", "review"])
      .optional(),
    org: text,
    q: text,
    repository: text,
    team: text,
    /** Comma-separated author logins. */
    authors: z.string().max(1000).optional(),
  }),
  users: z.object({ q: z.string().max(100).optional() }),
  jira: z.object({
    scope: z.enum(JIRA_SCOPES).optional(),
    board: text,
    filter: text,
    project: text,
    sprint: text,
    status: z.enum(JIRA_STATUSES).optional(),
    sort: z.enum(JIRA_SORTS).optional(),
    search: text,
    jql: z.string().max(JIRA_JQL_MAX).optional(),
    startAt: text,
  }),
  usage: z.object({ day: text }),
  /** A base branch's position; `fetch=1` fetches whatever the last fetch's age. */
  basePosition: z.object({
    base: z.string().max(250).optional(),
    branch: z.string().max(250).optional(),
    fetch: z.enum(["0", "1"]).optional(),
  }),
  /** An environment's log: one source, its last `lines` lines (at most 2000). */
  envLogs: z.object({
    source: z.enum(["setup", "container", "opencode"]).default("setup"),
    lines: z.coerce
      .number()
      .int()
      .min(1)
      .default(500)
      .transform((n) => Math.min(n, 2000)),
  }),
  directory,
  files: directory.extend({ query: z.string().max(500) }),
  review,
  reviewStage: directory,
  reviewImage: review.extend({
    side: z.enum(["old", "new"]),
    file: z.string(),
  }),
  forgejoImage: z.object({ side: z.enum(["old", "new"]), file: z.string() }),
  publish: directory.extend({ remote: text }),
  spec: directory.extend({ change: text, session: text }),
  activity: z.object({
    project: z.string().max(200).optional(),
    task: z.string().max(200).optional(),
    entity: entity.optional(),
    before: count.optional(),
    limit: count.refine((n) => Number(n) <= MAX_ACTIVITY_PAGE_SIZE).optional(),
  }),
  linkPull: z.object({ url: webUrl }),
  linkTicket: z.object({
    instance: webUrl,
    key: z.string().max(200).regex(JIRA_KEY),
  }),
};
