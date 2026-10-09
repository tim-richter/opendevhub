import { describe, expect, it } from "vitest";

import type { RawMessage } from "../../../src/server/opencode/client";
import {
  subagentsOf,
  toSessionTurns,
} from "../../../src/server/sessions/detail";
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
      },
      rawSession("ses_other"),
    ];
    const subs = subagentsOf("ses_root", all);
    expect(subs.map((s) => [s.id, s.title, s.cost])).toStrictEqual([
      ["ses_b", "Subagent", undefined],
      ["ses_a", expect.any(String), 3],
    ]);
  });
});
