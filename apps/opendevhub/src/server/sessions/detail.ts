import type {
  SessionTurn,
  SubagentSummary,
  TokenBreakdown,
  TranscriptAttachment,
  TranscriptMessage,
  TranscriptPart,
} from "../../shared/types";
import type {
  RawAssistantContent,
  RawFileAttachment,
  RawInstruction,
  RawMessage,
  RawSession,
  RawTokens,
} from "../opencode/client";
import { BRIEFING_KEY } from "../tasks/briefing";
import { rollUp, tokenTotal } from "./status";

/** How many of a session's newest messages its page reads, the most opencode returns at once; older turns are left out. */
export const DETAIL_MESSAGES = 200;
const PROMPT_CHARS = 2000;
const REPLY_CHARS = 1200;
/** The most of a transcript's text or reasoning part the detail carries. */
export const PART_CHARS = 20_000;
/** The most of a tool call's output the detail carries. */
export const TOOL_OUTPUT_CHARS = 4000;
const TOOL_STATUSES = new Set(["pending", "running", "completed", "error"]);
/** The input fields that say what a tool call did when opencode gives it no title, most telling first. */
const TOOL_SUBJECTS = [
  "command",
  "filePath",
  "path",
  "pattern",
  "url",
  "query",
  "description",
] as const;

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

type RawToolState = NonNullable<RawAssistantContent["state"]>;

/** What a tool call did: opencode's title for it, else the first telling field of its input. */
const toolTitle = (state: RawToolState | undefined): string | undefined => {
  if (state?.title) {
    return state.title;
  }
  const input = state?.input;
  if (!input || typeof input === "string") {
    return undefined;
  }
  for (const key of TOOL_SUBJECTS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return cut(value, PROMPT_CHARS);
    }
  }
  return undefined;
};

/** The text a tool call returned, if any. */
const toolOutput = (state: RawToolState | undefined): string | undefined => {
  const text = (state?.content ?? [])
    .filter((p) => p.type === "text" && p.text?.trim())
    .map((p) => p.text)
    .join("\n");
  return text.trim() ? cut(text, TOOL_OUTPUT_CHARS) : undefined;
};

const toPart = (c: RawAssistantContent): TranscriptPart | undefined => {
  if (c.type === "text" && c.text?.trim()) {
    return { kind: "text", text: cut(c.text, PART_CHARS) };
  }
  if (c.type === "reasoning" && c.text?.trim()) {
    const { created, completed } = c.time ?? {};
    return {
      kind: "reasoning",
      text: cut(c.text, PART_CHARS),
      ...(created !== undefined && completed !== undefined
        ? { duration: completed - created }
        : {}),
    };
  }
  if (c.type === "tool" && c.name) {
    const status = c.state?.status ?? "pending";
    const title = toolTitle(c.state);
    const output = toolOutput(c.state);
    const error = c.state?.error?.message?.trim();
    return {
      kind: "tool",
      name: c.name,
      status: TOOL_STATUSES.has(status)
        ? (status as Extract<TranscriptPart, { kind: "tool" }>["status"])
        : "pending",
      ...(title ? { title } : {}),
      ...(output ? { output } : {}),
      ...(error ? { error: cut(error, TOOL_OUTPUT_CHARS) } : {}),
    };
  }
  return undefined;
};

const DATA_MIME = /^data:(?<mime>[^,;]+)/u;

/** A user message's files other than its `@` mentions, by name; their bytes are left out. */
const attachmentsOf = (files: RawFileAttachment[]): TranscriptAttachment[] =>
  files
    .filter((f) => !f.mention)
    .map((f) => {
      const mime = DATA_MIME.exec(f.uri)?.groups?.mime;
      const name =
        f.name ??
        (f.uri.startsWith("data:")
          ? "attachment"
          : (f.uri.split("/").findLast(Boolean) ?? "file"));
      return { name, ...(mime ? { mime } : {}) };
    });

const toTranscriptMessage = (m: RawMessage): TranscriptMessage | undefined => {
  const created = m.time?.created ?? 0;
  if (m.type === "user") {
    const attachments = attachmentsOf(m.files ?? []);
    return {
      created,
      id: m.id,
      role: "user",
      text: cut(m.text ?? "", PART_CHARS),
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }
  if (m.type === "compaction") {
    return { created, id: m.id, role: "compaction" };
  }
  if (m.type !== "assistant") {
    return undefined;
  }
  const parts = (m.content ?? [])
    .map(toPart)
    .filter((p): p is TranscriptPart => p !== undefined);
  const error = m.error?.message;
  return {
    created,
    id: m.id,
    parts,
    role: "assistant",
    ...(m.time?.completed ? { completed: m.time.completed } : {}),
    ...(error ? { error } : {}),
    ...(m.agent ? { agent: m.agent } : {}),
    ...(m.model ? { model: m.model } : {}),
  };
};

/**
 * A session's transcript, oldest first, from its messages, newest first. User, assistant and compaction messages
 * are kept; other kinds, such as synthetic ones, are left out. A prompt and each text or reasoning part are cut
 * short when long.
 */
export const toTranscript = (newestFirst: RawMessage[]): TranscriptMessage[] =>
  newestFirst
    .toReversed()
    .map(toTranscriptMessage)
    .filter((m): m is TranscriptMessage => m !== undefined);

/**
 * The transcript with the task briefing first, when the session's instruction entries hold one. opencode adds no
 * message for an entry set before the first prompt, so the row comes from the entry itself.
 */
export const withBriefing = (
  transcript: TranscriptMessage[],
  instructions: RawInstruction[],
  created: number
): TranscriptMessage[] => {
  const value = instructions.find((i) => i.key === BRIEFING_KEY)?.value;
  if (typeof value !== "string" || !value.trim()) {
    return transcript;
  }
  return [
    {
      created,
      id: BRIEFING_KEY,
      role: "briefing",
      text: cut(value, PART_CHARS),
    },
    ...transcript,
  ];
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
        ...(s.outcome ? { outcome: s.outcome } : {}),
        ...(cost === undefined ? {} : { cost }),
        ...(tokens === undefined ? {} : { tokens }),
      };
    })
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
};
