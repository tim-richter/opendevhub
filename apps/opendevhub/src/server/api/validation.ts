import { validator } from "hono/validator";
import { z } from "zod";

import { JIRA_SCOPES, JIRA_SORTS, JIRA_STATUSES } from "../../shared/jira";
import { STACK_IDS } from "../../shared/stacks";
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
const flag = z.boolean().optional();
// Only literal true enables these options; preserve the existing conservative coercion.
const actionFlag = z
  .unknown()
  .transform((value) => value === true)
  .optional();
const directory = z.object({ directory: text });
const aiReview = z.object({
  projectId: z.string(),
  directory: z.string(),
  commitId: z.string(),
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

export const bodies = {
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
  forgejoWorktree: z.object({
    projectId: z.string(),
    branch: z.string(),
    commitId: z.string(),
  }),
  roots: z.object({ roots: z.array(z.string()) }),
  onboarding: z.object({ path: text, stack: z.enum(STACK_IDS) }),
  cleanup: z
    .object({ items: z.unknown() })
    .transform(({ items }) => ({ items: parseCleanupItems(items) })),
  node: z.object({ ssh: z.string(), label: text }),
  subscription: z.object({
    endpoint: text,
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: text, auth: text }).optional(),
  }),
  unsubscribe: z.object({ endpoint: text }),
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
  session: directory.extend({ title: text, prompt: text }),
  prompt: z.object({ text }),
  editor: directory.extend({ editor: text }),
  task: z.object({
    prompt: z.string(),
    title: text,
    where: z.enum(["worktree", "workspace"]).optional(),
    branch: text,
    base: text,
    environment: z.enum(["shared", "isolated"]).optional(),
    node: text,
    spec: flag,
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
          command: z.string(),
          where: z.enum(["host", "container"]).optional(),
          timeout: z.number().optional(),
        })
      )
      .nullable(),
  }),
  runChecks: directory.extend({ names: strings, approve: strings }),
  reviseSpec: directory.extend({ change: z.string(), feedback: z.string() }),
  approveSpec: directory.extend({
    change: z.string(),
    force: z.boolean().optional(),
  }),
  archiveSpec: directory.extend({ change: z.string() }),
  implementSpec: directory.extend({
    change: z.string(),
    variants,
    force: z.boolean().optional(),
  }),
};

const page = z.object({ page: text });
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
  }),
  jira: z.object({
    scope: z.enum(JIRA_SCOPES).optional(),
    board: text,
    filter: text,
    project: text,
    sprint: text,
    status: z.enum(JIRA_STATUSES).optional(),
    sort: z.enum(JIRA_SORTS).optional(),
    search: text,
    startAt: text,
  }),
  usage: z.object({ day: text }),
  directory,
  review,
  reviewImage: review.extend({
    side: z.enum(["old", "new"]),
    file: z.string(),
  }),
  forgejoImage: z.object({ side: z.enum(["old", "new"]), file: z.string() }),
  publish: directory.extend({ remote: text }),
  spec: directory.extend({ change: text }),
};
