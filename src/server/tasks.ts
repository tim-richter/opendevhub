import { MAX_VARIANTS } from "../shared/tasks";
import type { ModelRef, ModelsInfo, TaskMeta, TaskRequest, TaskVariantSpec } from "../shared/types";
import type { RawAgent, RawModel } from "./opencode/client";
import { InvalidRequestError, validateBranch } from "./worktrees";

const PROMPT_MAX = 100_000;
const TITLE_LIMIT = 200;
/** Provider ids, model ids, model variants and agent names. */
const NAME = /^[A-Za-z0-9._:/@-]{1,200}$/;

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseModel(value: unknown, n: number): ModelRef | undefined {
  if (value === undefined || value === null) return undefined;
  const o = (typeof value === "object" ? value : {}) as Record<string, unknown>;
  const id = str(o.id);
  const providerID = str(o.providerID);
  const variant = str(o.variant);
  if (!id || !providerID || !NAME.test(id) || !NAME.test(providerID) || (variant !== undefined && !NAME.test(variant))) {
    throw new InvalidRequestError(`variant ${n}: model needs an id and a providerID`);
  }
  return { id, providerID, ...(variant ? { variant } : {}) };
}

function parseVariant(value: unknown, n: number): TaskVariantSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidRequestError(`variant ${n} must be an object`);
  const o = value as Record<string, unknown>;
  const model = parseModel(o.model, n);
  const agent = str(o.agent)?.trim();
  if (o.agent !== undefined && o.agent !== null && o.agent !== "" && (!agent || !NAME.test(agent))) {
    throw new InvalidRequestError(`variant ${n}: invalid agent`);
  }
  return { ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
}

/** Validates `POST …/tasks`; unknown fields are ignored. */
export function parseTaskRequest(body: Record<string, unknown>): TaskRequest {
  const prompt = str(body.prompt)?.trim() ?? "";
  if (!prompt) throw new InvalidRequestError("the prompt is empty");
  if (prompt.length > PROMPT_MAX) throw new InvalidRequestError(`the prompt is longer than ${PROMPT_MAX} characters`);
  const title = str(body.title)?.trim() || undefined;
  if (title && title.length > TITLE_LIMIT) throw new InvalidRequestError(`the title must be at most ${TITLE_LIMIT} characters`);
  const where = body.where ?? "worktree";
  if (where !== "worktree" && where !== "workspace") throw new InvalidRequestError(`invalid where "${String(where)}"`);
  const branch = str(body.branch)?.trim() ? validateBranch(str(body.branch)!) : undefined;
  const base = str(body.base)?.trim() ? validateBranch(str(body.base)!) : undefined;
  const raw = body.variants === undefined || body.variants === null ? [{}] : body.variants;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_VARIANTS) {
    throw new InvalidRequestError(`variants must be a list of 1 to ${MAX_VARIANTS}`);
  }
  const variants = raw.map((v, i) => parseVariant(v, i + 1));
  if (where === "workspace") {
    if (variants.length > 1) throw new InvalidRequestError("several variants need a worktree each; choose New worktree");
    if (branch || base) throw new InvalidRequestError("branch and base only apply to a new worktree");
  }
  return { prompt, ...(title ? { title } : {}), where, ...(branch ? { branch } : {}), ...(base ? { base } : {}), variants };
}

/** The task a session belongs to, from `metadata.opendevhub`; undefined when it has none or it is malformed. */
export function parseTaskMeta(metadata: unknown): TaskMeta | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const m = (metadata as { opendevhub?: unknown }).opendevhub;
  if (!m || typeof m !== "object") return undefined;
  const { task, variant, of, title, branch, discarded } = m as Record<string, unknown>;
  if (typeof task !== "string" || !task.startsWith("tsk_")) return undefined;
  if (typeof variant !== "number" || typeof of !== "number" || !Number.isInteger(variant) || !Number.isInteger(of)) return undefined;
  if (variant < 1 || of < variant) return undefined;
  return { task, variant, of, title: typeof title === "string" ? title : "",
    ...(typeof branch === "string" ? { branch } : {}),
    ...(discarded === true ? { discarded: true } : {}) };
}

/** The session's metadata with `opendevhub.discarded` set. opencode's PATCH replaces metadata, so keep every key. */
export function discardMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const own = metadata?.opendevhub;
  return { ...metadata, opendevhub: { ...(own && typeof own === "object" ? own : {}), discarded: true } };
}

/** What the New task dialog may show. Copies named fields only: opencode's model info holds API keys. */
export function toModelsInfo(models: RawModel[], def: RawModel | undefined, agents: RawAgent[]): ModelsInfo {
  return {
    models: models
      .filter((m) => m.enabled !== false && m.status !== "deprecated")
      .map((m) => ({
        id: m.id,
        providerID: m.providerID,
        name: m.name || m.id,
        variants: (m.variants ?? []).map((v) => v.id).filter((v): v is string => typeof v === "string"),
      })),
    ...(def ? { default: { id: def.id, providerID: def.providerID } } : {}),
    agents: agents
      .filter((a) => a.mode !== "subagent" && !a.hidden)
      .map((a) => ({ id: a.id, name: a.name || a.id, ...(a.description ? { description: a.description } : {}) })),
  };
}
