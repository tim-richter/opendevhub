import type {
  SessionTurn,
  SubagentSummary,
  TokenBreakdown,
} from "../../shared/types";
import type { RawMessage, RawSession, RawTokens } from "../opencode/client";
import { rollUp, tokenTotal } from "./status";

/** How many of a session's newest messages its page reads, the most opencode returns at once; older turns are left out. */
export const DETAIL_MESSAGES = 200;
const PROMPT_CHARS = 2000;
const REPLY_CHARS = 1200;

const cut = (text: string, max: number): string => {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
};

export const toBreakdown = (t: RawTokens): TokenBreakdown => ({
  cacheRead: t.cache?.read ?? 0,
  cacheWrite: t.cache?.write ?? 0,
  input: t.input ?? 0,
  output: t.output ?? 0,
  reasoning: t.reasoning ?? 0,
});

const replyText = (m: RawMessage): string =>
  (m.content ?? [])
    .filter((c) => c.type === "text" && c.text?.trim())
    .map((c) => c.text?.trim())
    .join("\n\n");

/** One prompt's turn from its assistant messages, oldest first. */
const toTurn = (prompt: RawMessage, replies: RawMessage[]): SessionTurn => {
  let cost: number | undefined;
  let tokens: number | undefined;
  let tools = 0;
  let failedTools = 0;
  const files = new Set<string>();
  for (const r of replies) {
    if (typeof r.cost === "number") {
      cost = (cost ?? 0) + r.cost;
    }
    if (r.tokens) {
      tokens = (tokens ?? 0) + tokenTotal(r.tokens);
    }
    for (const c of r.content ?? []) {
      if (c.type === "tool") {
        tools += 1;
        if (c.state?.status === "error") {
          failedTools += 1;
        }
      }
    }
    for (const f of r.snapshot?.files ?? []) {
      files.add(f);
    }
  }
  const last = replies.at(-1);
  const reply = replies.map(replyText).findLast(Boolean);
  const error = last?.error?.message;
  return {
    created: prompt.time?.created ?? 0,
    failedTools,
    files: files.size,
    id: prompt.id,
    prompt: cut(prompt.text ?? "", PROMPT_CHARS),
    steps: replies.length,
    tools,
    ...(last?.time?.completed ? { completed: last.time.completed } : {}),
    ...(cost === undefined ? {} : { cost }),
    ...(tokens === undefined ? {} : { tokens }),
    ...(reply ? { reply: cut(reply, REPLY_CHARS) } : {}),
    ...(error ? { error } : {}),
    ...(last?.agent ? { agent: last.agent } : {}),
    ...(last?.model ? { model: last.model } : {}),
  };
};

/**
 * A session's turns, newest first, from its messages, newest first. A turn is a user message and the assistant
 * messages after it, up to the next one; messages before the oldest user message listed belong to a turn whose
 * prompt is cut off, so they are left out.
 */
export const toSessionTurns = (newestFirst: RawMessage[]): SessionTurn[] => {
  const turns: SessionTurn[] = [];
  let replies: RawMessage[] = [];
  for (const m of newestFirst) {
    if (m.type === "assistant") {
      replies.push(m);
    } else if (m.type === "user") {
      turns.push(toTurn(m, replies.toReversed()));
      replies = [];
    }
  }
  return turns;
};

/** The session's direct subagents, newest first, each with its own subagents' cost and tokens added in. */
export const subagentsOf = (
  sessionId: string,
  all: RawSession[]
): SubagentSummary[] => {
  const parents = new Map(all.map((s) => [s.id, s.parentID]));
  const within = (id: string, ancestor: string): boolean => {
    const seen = new Set<string>();
    for (
      let at: string | undefined = id;
      at && !seen.has(at);
      at = parents.get(at)
    ) {
      if (at === ancestor) {
        return true;
      }
      seen.add(at);
    }
    return false;
  };
  return all
    .filter((s) => s.parentID === sessionId)
    .map((s) => {
      // Without its parent listed, the subagent is the root its subtree rolls up into.
      const { cost, tokens } =
        rollUp(all.filter((x) => within(x.id, s.id))).get(s.id) ?? {};
      return {
        id: s.id,
        title: s.title || "Subagent",
        updatedAt: s.time.updated,
        ...(s.agent ? { agent: s.agent } : {}),
        ...(cost === undefined ? {} : { cost }),
        ...(tokens === undefined ? {} : { tokens }),
      };
    })
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
};
