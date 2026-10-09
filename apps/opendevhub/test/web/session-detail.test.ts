import { describe, expect, it } from "vitest";

import type { SessionTurn } from "../../src/shared/types";
import {
  breakdownLabel,
  contextShare,
  turnActivity,
  turnDuration,
} from "../../src/web/session-detail";

const turn = (over: Partial<SessionTurn> = {}): SessionTurn => ({
  created: 1000,
  failedTools: 0,
  files: 0,
  id: "msg_1",
  prompt: "Fix it",
  steps: 0,
  tools: 0,
  ...over,
});

describe(contextShare, () => {
  it("is the share of the window in use, capped at 1, and unknown without both numbers", () => {
    expect(contextShare(50_000, 200_000)).toBe(0.25);
    expect(contextShare(300_000, 200_000)).toBe(1);
    expect(contextShare(undefined, 200_000)).toBeUndefined();
    expect(contextShare(50_000, undefined)).toBeUndefined();
    expect(contextShare(50_000, 0)).toBeUndefined();
  });
});

describe(breakdownLabel, () => {
  it("names each kind of token used, the cache last", () => {
    expect(
      breakdownLabel({
        cacheRead: 40_100,
        cacheWrite: 2000,
        input: 12_000,
        output: 900,
        reasoning: 0,
      })
    ).toBe("in 12.0k · out 900 · cache 40.1k read, 2.0k written");
    expect(
      breakdownLabel({
        cacheRead: 0,
        cacheWrite: 0,
        input: 5,
        output: 0,
        reasoning: 7,
      })
    ).toBe("in 5 · reasoning 7");
  });
});

describe(turnDuration, () => {
  it("is how long a finished turn took, and nothing while it runs", () => {
    expect(turnDuration(turn({ completed: 4000 }), false)).toBe("3.0 s");
    expect(turnDuration(turn({ completed: 4000 }), true)).toBeUndefined();
    expect(turnDuration(turn(), false)).toBeUndefined();
  });
});

describe(turnActivity, () => {
  it("counts steps, tool calls and files, leaving out what is zero", () => {
    expect(
      turnActivity(turn({ failedTools: 1, files: 1, steps: 3, tools: 12 }))
    ).toBe("3 steps · 12 tool calls (1 failed) · 1 file");
    expect(turnActivity(turn({ steps: 1 }))).toBe("1 step");
    expect(turnActivity(turn())).toBe("");
  });
});
