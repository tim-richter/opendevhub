import { describe, expect, it } from "vitest";

import { jiraToMarkdown } from "../../src/server/jira-markup";

const lines = (...l: string[]) => l.join("\n");

describe("jiraToMarkdown", () => {
  it("converts nested lists with inline code", () => {
    expect(
      jiraToMarkdown(
        lines(
          "* {{DateTime}} Component:",
          "** Props:",
          '*** Variant = primary / secondary (Default "primary")',
          "*** DateTime object",
          "** Tooltip:",
          '*** When Timezone = "UTC", show local time, prefixed with "Local Time: ".'
        )
      )
    ).toBe(
      lines(
        "- `DateTime` Component:",
        "  - Props:",
        '    - Variant = primary / secondary (Default "primary")',
        "    - DateTime object",
        "  - Tooltip:",
        '    - When Timezone = "UTC", show local time, prefixed with "Local Time: ".'
      )
    );
  });

  it("indents mixed ordered and bullet lists by parent marker width", () => {
    expect(jiraToMarkdown(lines("# one", "#* nested", "# two"))).toBe(
      lines("1. one", "   - nested", "1. two")
    );
  });

  it("clamps list depth that skips levels", () => {
    expect(jiraToMarkdown(lines("intro", "", "*** deep"))).toBe(
      lines("intro", "", "- deep")
    );
  });

  it("converts headings, rules and block quotes", () => {
    expect(
      jiraToMarkdown(lines("h2. Title *here*", "----", "bq. quoted"))
    ).toBe(lines("## Title **here**", "", "---", "", "> quoted"));
  });

  it("keeps newlines in paragraphs as hard breaks", () => {
    expect(jiraToMarkdown("Fails on Safari\nAcceptance: ok\r\n\r\nNext")).toBe(
      lines("Fails on Safari\\", "Acceptance: ok", "", "Next")
    );
  });

  it("converts emphasis only at word boundaries", () => {
    expect(
      jiraToMarkdown(
        "*a* and *b*, 2 * 3 * 4, snake_case_name, -gone-, a-b-c, +new+"
      )
    ).toBe("**a** and **b**, 2 * 3 * 4, snake_case_name, ~~gone~~, a-b-c, new");
  });

  it("does not format inside code", () => {
    expect(
      jiraToMarkdown(
        lines(
          "{code:java}",
          "int *p* = a-b-c;",
          "```",
          "{code}",
          "{noformat}*raw*{noformat} {{*x*}}"
        )
      )
    ).toBe(
      lines(
        "````java",
        "int *p* = a-b-c;",
        "```",
        "````",
        "",
        "```",
        "*raw*",
        "```",
        "",
        "`*x*`"
      )
    );
  });

  it("converts links, mentions and images", () => {
    expect(
      jiraToMarkdown(
        "[*Docs*|https://x.io/a-b-] [https://y.io] [~jdoe] [not a link] !shot.png|thumbnail! https://z.io/-q-"
      )
    ).toBe(
      "[**Docs**](https://x.io/a-b-) <https://y.io> @jdoe [not a link] [image: shot.png] https://z.io/-q-"
    );
  });

  it("converts tables, adding a header row when missing", () => {
    expect(
      jiraToMarkdown(lines("||A||B||", "|1|[x|https://x.io]|", "", "|c|d|"))
    ).toBe(
      lines(
        "| A | B |",
        "| --- | --- |",
        "| 1 | [x](https://x.io) |",
        "",
        "|  |  |",
        "| --- | --- |",
        "| c | d |"
      )
    );
  });

  it("unwraps quote, panel and color macros", () => {
    expect(
      jiraToMarkdown(
        lines(
          "{quote}",
          "line one",
          "line two",
          "{quote}",
          "{panel:title=Note}{color:red}careful{color}{panel}"
        )
      )
    ).toBe(lines("> line one\\", "> line two", "", "**Note**\\", "careful"));
  });
});
