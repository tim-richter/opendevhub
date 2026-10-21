import { describe, expect, it } from "vitest";

import type { RawMessage } from "../../../src/server/opencode/client";
import {
  PART_CHARS,
  subagentsOf,
  toSessionTurns,
  toTranscript,
  withBriefing,
} from "../../../src/server/sessions/detail";
import type { TranscriptMessage } from "../../../src/shared/types";
import { rawSession } from "../../helpers/fake-opencode";

const tokens = (input: number) => ({
  cache: { read: 0, write: 0 },
  input,
  output: 1,
  reasoning: 0,
});

describe(toSessionTurns, () => {
  it("groups replies under the prompt before them, newest turn first", () => {
    const newestFirst: RawMessage[] = [
      { id: "msg_5", type: "assistant", time: { created: 50 } },
      { id: "msg_4", type: "user", text: "Add tests", time: { created: 40 } },
      {
        content: [
          { type: "text", text: "All fixed." },
          { name: "edit", state: { status: "completed" }, type: "tool" },
        ],
        cost: 0.25,
        id: "msg_3",
        snapshot: { files: ["b.ts"] },
        time: { completed: 31, created: 30 },
        tokens: tokens(20),
        type: "assistant",
      },
      {
        content: [
          { type: "reasoning", text: "thinking" },
          { name: "read", state: { status: "error" }, type: "tool" },
          { name: "edit", state: { status: "completed" }, type: "tool" },
        ],
        cost: 0.5,
        id: "msg_2",
        snapshot: { files: ["a.ts", "b.ts"] },
        time: { completed: 21, created: 20 },
        tokens: tokens(10),
        type: "assistant",
      },
      {
        id: "msg_1",
        text: "  Fix the login  ",
        time: { created: 10 },
        type: "user",
      },
      // A reply whose prompt is older than the messages read.
      { id: "msg_0", type: "assistant", time: { created: 5 } },
    ];
    const turns = toSessionTurns(newestFirst);
    expect(turns.map((t) => t.id)).toStrictEqual(["msg_4", "msg_1"]);
    expect(turns[0]).toStrictEqual({
      created: 40,
      failedTools: 0,
      files: 0,
      id: "msg_4",
      prompt: "Add tests",
      steps: 1,
      tools: 0,
    });
    expect(turns[1]).toStrictEqual({
      completed: 31,
      cost: 0.75,
      created: 10,
      failedTools: 1,
      files: 2,
      id: "msg_1",
      prompt: "Fix the login",
      reply: "All fixed.",
      steps: 2,
      tokens: 32,
      tools: 3,
    });
  });

  it("keeps the last reply with text and the last reply's error", () => {
    const [turn] = toSessionTurns([
      {
        error: { message: "rate limited" },
        id: "msg_3",
        type: "assistant",
      },
      {
        content: [{ type: "text", text: "x".repeat(2000) }],
        id: "msg_2",
        type: "assistant",
      },
      { id: "msg_1", text: "go", type: "user" },
    ]);
    expect(turn.error).toBe("rate limited");
    expect(turn.reply).toHaveLength(1200);
    expect(turn.reply?.endsWith("…")).toBe(true);
  });
});

describe(subagentsOf, () => {
  it("lists direct children, newest first, each with its own subagents rolled in", () => {
    const all = [
      rawSession("ses_root"),
      { ...rawSession("ses_a"), cost: 1, parentID: "ses_root" },
      { ...rawSession("ses_a1"), cost: 2, parentID: "ses_a" },
      {
        ...rawSession("ses_b"),
        parentID: "ses_root",
        time: { created: 1, updated: 99 },
        title: "",
        outcome: "interrupted" as const,
      },
      rawSession("ses_other"),
    ];
    const subs = subagentsOf("ses_root", all);
    expect(subs.map((s) => [s.id, s.title, s.cost])).toStrictEqual([
      ["ses_b", "Subagent", undefined],
      ["ses_a", expect.any(String), 3],
    ]);
    expect(subs[0].outcome).toBe("interrupted");
  });
});

describe(toTranscript, () => {
  it("lists a user message's attached files by name, leaving out its mentions and the bytes", () => {
    const [message] = toTranscript([
      {
        files: [
          {
            mention: { end: 5, start: 0, text: "@a.ts" },
            name: "a.ts",
            uri: "file:///w/a.ts",
          },
          { name: "shot.png", uri: "data:image/png;base64,aGk=" },
          { uri: "data:text/plain;base64,aGk=" },
        ],
        id: "msg_1",
        text: "@a.ts and these",
        time: { created: 10 },
        type: "user",
      },
    ]);
    expect(message).toStrictEqual({
      attachments: [
        { mime: "image/png", name: "shot.png" },
        { mime: "text/plain", name: "attachment" },
      ],
      created: 10,
      id: "msg_1",
      role: "user",
      text: "@a.ts and these",
    });
  });

  it("lists user, assistant and compaction messages oldest first, leaving out other kinds", () => {
    const newestFirst: RawMessage[] = [
      {
        id: "msg_5",
        text: "yes, use CSS variables",
        time: { created: 50 },
        type: "user",
      },
      { id: "msg_4", time: { created: 40 }, type: "synthetic" },
      {
        content: [{ text: "Which approach?", type: "text" }],
        id: "msg_3",
        time: { completed: 31, created: 30 },
        type: "assistant",
      },
      { id: "msg_2", time: { created: 20 }, type: "compaction" },
      {
        id: "msg_1",
        text: "add dark mode",
        time: { created: 10 },
        type: "user",
      },
    ];
    expect(toTranscript(newestFirst)).toStrictEqual([
      { created: 10, id: "msg_1", role: "user", text: "add dark mode" },
      { created: 20, id: "msg_2", role: "compaction" },
      {
        completed: 31,
        created: 30,
        id: "msg_3",
        parts: [{ kind: "text", text: "Which approach?" }],
        role: "assistant",
      },
      {
        created: 50,
        id: "msg_5",
        role: "user",
        text: "yes, use CSS variables",
      },
    ]);
  });

  it("keeps an assistant message's parts in order with each tool call's status and title", () => {
    const [message] = toTranscript([
      {
        agent: "build",
        content: [
          { text: "planning", type: "reasoning" },
          { text: "   ", type: "text" },
          {
            name: "bash",
            state: { status: "error", title: "pnpm test" },
            type: "tool",
          },
          { name: "read", state: { status: "running" }, type: "tool" },
          { name: "edit", state: { status: "odd" }, type: "tool" },
          { name: "glob", type: "tool" },
          { type: "step-start" },
          { text: "Done.", type: "text" },
        ],
        error: { message: "Tool failed" },
        id: "msg_1",
        model: { id: "m", providerID: "p" },
        time: { created: 10 },
        type: "assistant",
      },
    ]);
    expect(message).toStrictEqual({
      agent: "build",
      created: 10,
      error: "Tool failed",
      id: "msg_1",
      model: { id: "m", providerID: "p" },
      parts: [
        { kind: "reasoning", text: "planning" },
        { kind: "tool", name: "bash", status: "error", title: "pnpm test" },
        { kind: "tool", name: "read", status: "running" },
        { kind: "tool", name: "edit", status: "pending" },
        { kind: "tool", name: "glob", status: "pending" },
        { kind: "text", text: "Done." },
      ],
      role: "assistant",
    });
  });

  it("cuts long text, reasoning and prompts short", () => {
    const long = "x".repeat(PART_CHARS + 10);
    const transcript = toTranscript([
      {
        content: [
          { text: long, type: "text" },
          { text: long, type: "reasoning" },
        ],
        id: "msg_2",
        type: "assistant",
      },
      { id: "msg_1", text: long, type: "user" },
    ]);
    const texts = transcript.flatMap((m) => {
      if (m.role === "user") {
        return [m.text];
      }
      return m.role === "assistant"
        ? m.parts.map((p) => (p.kind === "tool" ? "" : p.text))
        : [];
    });
    expect(texts.map((t) => t.length)).toStrictEqual([
      PART_CHARS,
      PART_CHARS,
      PART_CHARS,
    ]);
    expect(texts.every((t) => t.endsWith("…"))).toBe(true);
  });
});

describe(withBriefing, () => {
  const prompt: TranscriptMessage = {
    created: 5,
    id: "msg_1",
    role: "user",
    text: "go",
  };

  it("puts the task briefing entry first", () => {
    expect(
      withBriefing(
        [prompt],
        [
          { key: "other", value: "x" },
          { key: "opendevhub-task", value: "# Task briefing" },
        ],
        2
      )
    ).toStrictEqual([
      {
        created: 2,
        id: "opendevhub-task",
        role: "briefing",
        text: "# Task briefing",
      },
      prompt,
    ]);
  });

  it("adds nothing without a text briefing entry", () => {
    expect(withBriefing([prompt], [], 2)).toStrictEqual([prompt]);
    expect(
      withBriefing([prompt], [{ key: "opendevhub-task", value: { a: 1 } }], 2)
    ).toStrictEqual([prompt]);
  });

  it("keeps opencode's system messages out of the transcript", () => {
    const system = {
      id: "msg_sys",
      metadata: { instructionSources: ["api/opendevhub-task"] },
      text: 'The context under "opendevhub-task" changed',
      type: "system",
    } as RawMessage;
    expect(toTranscript([system])).toStrictEqual([]);
  });
});
