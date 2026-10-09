import { describe, expect, it } from "vitest";

import {
  aiQuickReviewPrompt,
  parseAiReview,
} from "../../../src/server/integrations/ai-review";
import type { ForgejoPullDetails } from "../../../src/shared/forgejo";

describe("parseAiReview", () => {
  it("reads the last fenced JSON block and normalises findings", () => {
    const text = [
      "Here is a draft:",
      "```json",
      '{"findings": []}',
      "```",
      "And the final answer:",
      "```json",
      JSON.stringify({
        summary: " Looks risky ",
        findings: [
          {
            file: "b/src/a.ts",
            line: 10,
            start: 8,
            severity: "blocker",
            body: "Null deref",
          },
          {
            file: "src/a.ts",
            line: 4,
            side: "old",
            severity: "weird",
            body: "Removed check",
          },
          { file: "src/a.ts", line: 4, start: 9, body: "Bad range" },
          { body: "No tests" },
          { file: "src/a.ts", line: 0, body: "Line zero is general" },
          { file: "src/a.ts", line: 3, body: "  " },
          "nonsense",
        ],
      }),
      "```",
    ].join("\n");
    expect(parseAiReview(text)).toEqual({
      summary: "Looks risky",
      findings: [
        {
          file: "src/a.ts",
          line: 10,
          start: 8,
          side: "new",
          severity: "blocker",
          body: "Null deref",
        },
        {
          file: "src/a.ts",
          line: 4,
          side: "old",
          severity: "minor",
          body: "Removed check",
        },
        {
          file: "src/a.ts",
          line: 4,
          side: "new",
          severity: "minor",
          body: "Bad range",
        },
        { severity: "minor", body: "No tests" },
        { severity: "minor", body: "Line zero is general" },
      ],
    });
  });

  it("accepts bare JSON and a bare array", () => {
    expect(parseAiReview('Sure. {"summary": "fine", "findings": []}')).toEqual({
      summary: "fine",
      findings: [],
    });
    expect(
      parseAiReview('[{"body": "x", "severity": "nit"}]').findings
    ).toEqual([{ body: "x", severity: "nit" }]);
  });

  it("rejects replies without JSON", () => {
    expect(() => parseAiReview("I found nothing.")).toThrow(/JSON/u);
  });
});

describe("aiQuickReviewPrompt", () => {
  it("embeds the description and a bounded diff", () => {
    const details = {
      pull: { owner: "o", repo: "r", number: 1, title: "T", url: "u" },
      body: "Desc",
      base: "main",
      head: "h",
      headSha: "abc",
    } as ForgejoPullDetails;
    const prompt = aiQuickReviewPrompt(details, "x".repeat(200_000));
    expect(prompt).toContain("Desc");
    expect(prompt).toContain("cut short");
    expect(prompt.length).toBeLessThan(160_000);
  });
});
