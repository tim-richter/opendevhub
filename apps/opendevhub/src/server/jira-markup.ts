/**
 * Converts Jira wiki markup (what REST API v2 returns for descriptions) to
 * GitHub-flavored Markdown. Approach follows jira2md's regex pipeline, but
 * code is protected from inline rules, emphasis only matches at word
 * boundaries, and lists/tables/paragraphs are rebuilt line by line.
 */

const NEWLINES = /\r\n?/gu;
const CODE_BLOCK = /\{code(?::(?<params>[^}]*))?\}(?<code>[\s\S]*?)\{code\}/gu;
const NOFORMAT_BLOCK = /\{noformat(?::[^}]*)?\}(?<code>[\s\S]*?)\{noformat\}/gu;
const QUOTE_BLOCK = /\{quote\}(?<quote>[\s\S]*?)\{quote\}/gu;
const PANEL_OPEN =
  /\{(?:panel|info|note|warning|tip|expand)(?::(?<params>[^}]*))?\}/gu;
const PANEL_CLOSE = /\{(?:panel|info|note|warning|tip|expand)\}/gu;
const DROPPED_MACROS = /\{(?:color(?::[^}]*)?|anchor:[^}]*)\}/gu;
const BACKTICK_RUN = /`+/gu;
const OUTER_NEWLINES = /^\n|\n$/gu;

// Private-use characters delimit stashed fragments; they never occur in Jira text.
const STASH_OPEN = String.fromCodePoint(0xe0_00);
const STASH_CLOSE = String.fromCodePoint(0xe0_01);
const PLACEHOLDER = new RegExp(
  `${STASH_OPEN}(?<index>\\d+)${STASH_CLOSE}`,
  "gu"
);
const PLACEHOLDER_LINE = new RegExp(`^${STASH_OPEN}\\d+${STASH_CLOSE}$`, "u");

const HEADING = /^h(?<level>[1-6])\.\s*(?<text>.*)$/u;
const QUOTE_LINE = /^bq\.\s?(?<text>.*)$/u;
const RULE = /^-{4,}$/u;
const LIST_ITEM = /^(?:(?<prefix>[*#]+)|-)\s+(?<text>.*)$/u;
const TABLE_ROW = /^\|/u;
const TABLE_EDGES = /^\|\|?|\|\|?$/gu;
const TABLE_CELL_SPLIT = /\|\|?/u;
const LEADING_GT = /^>/u;

const INLINE_CODE = /\{\{(?<code>.+?)\}\}/gu;
const LINK = /\[(?<inner>[^\]\n]+)\]/gu;
const LINK_TARGET = /^(?:[a-z][a-z\d+.-]*:|\/|#)/iu;
const BARE_URL = /^(?:https?|ftp|mailto):\S+$/iu;
const IMAGE = /!(?<name>[^\s!|]+)(?:\|[^!\n]*)?!/gu;
const IMAGE_FILE = /\.(?:png|jpe?g|gif|svg|webp|bmp)$/iu;
const ABSOLUTE_URL = /^https?:\/\//iu;
const URL_IN_TEXT = /https?:\/\/[^\s<>\]]+/gu;
const NEEDS_ANGLE_BRACKETS = /[\s()]/u;
const BOLD = /(?<before>^|[^\w*])\*(?=\S)(?<text>[^*\n]*?\S)\*(?![\w*])/gu;
const STRIKE = /(?<before>^|[^\w-])-(?=\S)(?<text>[^\-\n]*?\S)-(?![\w-])/gu;
const INSERT = /(?<before>^|[^\w+])\+(?=\S)(?<text>[^+\n]*?\S)\+(?![\w+])/gu;

const ORDERED_MARKER = "1. ";
const BULLET_MARKER = "- ";

type Kind = "blank" | "block" | "list" | "quote" | "table" | "text";

/** Code fence or span delimiter longer than any backtick run in `content`. */
const fenceFor = (content: string, min: number): string => {
  const longest = Math.max(
    0,
    ...(content.match(BACKTICK_RUN) ?? []).map((run) => run.length)
  );
  return "`".repeat(Math.max(min, longest + 1));
};

const codeLanguage = (params: string | undefined): string => {
  for (const param of params?.split("|") ?? []) {
    const [key, value] = param.split("=");
    if (value === undefined) {
      return key.trim();
    }
    if (key.trim() === "language") {
      return value.trim();
    }
  }
  return "";
};

const linkDestination = (url: string): string =>
  NEEDS_ANGLE_BRACKETS.test(url) ? `<${url}>` : url;

class Converter {
  private readonly stashed: string[] = [];

  /** Hide already-converted Markdown from later regex passes. */
  private stash(markdown: string): string {
    return `${STASH_OPEN}${this.stashed.push(markdown) - 1}${STASH_CLOSE}`;
  }

  private restore(text: string): string {
    return text.replace(PLACEHOLDER, (_, index: string) =>
      this.restore(this.stashed[Number(index)])
    );
  }

  private codeBlock(language: string, content: string): string {
    const body = content.replace(OUTER_NEWLINES, "");
    const fence = fenceFor(body, 3);
    return `\n${this.stash(`${fence}${language}\n${body}\n${fence}`)}\n`;
  }

  private emphasis(text: string): string {
    return text
      .replace(BOLD, "$<before>**$<text>**")
      .replace(STRIKE, "$<before>~~$<text>~~")
      .replace(INSERT, "$<before>$<text>");
  }

  private link(raw: string, inner: string): string {
    const pipe = inner.lastIndexOf("|");
    if (pipe === -1) {
      if (inner.startsWith("~")) {
        return `@${inner.slice(1)}`;
      }
      return BARE_URL.test(inner) ? this.stash(`<${inner}>`) : raw;
    }
    const label = inner.slice(0, pipe).trim();
    const url = inner.slice(pipe + 1).trim();
    if (!LINK_TARGET.test(url)) {
      return raw;
    }
    return this.stash(`[${this.emphasis(label)}](${linkDestination(url)})`);
  }

  private image(name: string): string {
    if (ABSOLUTE_URL.test(name)) {
      return this.stash(`![](${linkDestination(name)})`);
    }
    // Attachment file names don't resolve outside Jira.
    return this.stash(`[image: ${name}]`);
  }

  /** Stash code, links, images and URLs so emphasis and table splitting skip them. */
  private protect(text: string): string {
    return text
      .replace(INLINE_CODE, (_, code: string) => {
        const fence = fenceFor(code, 1);
        const pad = code.startsWith("`") || code.endsWith("`") ? " " : "";
        return this.stash(`${fence}${pad}${code}${pad}${fence}`);
      })
      .replace(LINK, (raw, inner: string) => this.link(raw, inner))
      .replace(IMAGE, (raw, name: string) =>
        ABSOLUTE_URL.test(name) || IMAGE_FILE.test(name)
          ? this.image(name)
          : raw
      )
      .replace(URL_IN_TEXT, (url) => this.stash(url));
  }

  private inline(text: string): string {
    return this.emphasis(this.protect(text));
  }

  private table(rows: string[]): string[] {
    const cells = rows.map((row) =>
      this.protect(row)
        .replace(TABLE_EDGES, "")
        .split(TABLE_CELL_SPLIT)
        .map((cell) => this.emphasis(cell.trim()))
    );
    const columns = Math.max(...cells.map((row) => row.length));
    const format = (row: string[]) =>
      `| ${Array.from({ length: columns }, (_, i) => row[i] ?? "").join(" | ")} |`;
    const header = rows[0].startsWith("||")
      ? cells.shift()
      : Array.from({ length: columns }, () => "");
    return [
      format(header ?? []),
      format(Array.from({ length: columns }, () => "---")),
      ...cells.map(format),
    ];
  }

  private classify(line: string): Kind {
    if (line === "") {
      return "blank";
    }
    if (PLACEHOLDER_LINE.test(line) || HEADING.test(line) || RULE.test(line)) {
      return "block";
    }
    if (QUOTE_LINE.test(line)) {
      return "quote";
    }
    if (LIST_ITEM.test(line)) {
      return "list";
    }
    return TABLE_ROW.test(line) ? "table" : "text";
  }

  private block(line: string): string {
    const heading = HEADING.exec(line);
    if (heading) {
      const { level, text } = heading.groups ?? {};
      return `${"#".repeat(Number(level))} ${this.inline(text ?? "")}`;
    }
    return RULE.test(line) ? "---" : line;
  }

  /** Re-indent list items; Markdown nests by the parent marker's width. */
  private list(lines: string[]): string[] {
    let widths: number[] = [];
    return lines.map((line) => {
      const { prefix = "*", text = "" } = LIST_ITEM.exec(line)?.groups ?? {};
      const depth = Math.min(prefix.length, widths.length + 1);
      widths = widths.slice(0, depth - 1);
      const marker = prefix.endsWith("#") ? ORDERED_MARKER : BULLET_MARKER;
      const indent = " ".repeat(widths.reduce((sum, w) => sum + w, 0));
      widths.push(marker.length);
      return `${indent}${marker}${this.inline(text)}`;
    });
  }

  /** Jira renders every newline; Markdown needs explicit hard breaks. */
  private paragraph(lines: string[], prefix: string): string[] {
    return lines.map(
      (line, i) => `${prefix}${line}${i < lines.length - 1 ? "\\" : ""}`
    );
  }

  private render(kind: Kind, lines: string[]): string[] {
    switch (kind) {
      case "block": {
        return lines.map((line) => this.block(line));
      }
      case "list": {
        return this.list(lines);
      }
      case "table": {
        return this.table(lines);
      }
      case "quote": {
        return this.paragraph(
          lines.map((line) =>
            this.inline(QUOTE_LINE.exec(line)?.groups?.text ?? "")
          ),
          "> "
        );
      }
      default: {
        return this.paragraph(
          lines.map((line) => this.inline(line).replace(LEADING_GT, "\\>")),
          ""
        );
      }
    }
  }

  convert(markup: string): string {
    const prepared = markup
      .replace(NEWLINES, "\n")
      .replace(CODE_BLOCK, (_, params: string | undefined, code: string) =>
        this.codeBlock(codeLanguage(params), code)
      )
      .replace(NOFORMAT_BLOCK, (_, code: string) => this.codeBlock("", code))
      .replace(QUOTE_BLOCK, (_, quote: string) =>
        quote
          .replace(OUTER_NEWLINES, "")
          .split("\n")
          .map((line) => `\nbq. ${line}`)
          .join("")
      )
      .replace(PANEL_OPEN, (_, params: string | undefined) => {
        const title = params
          ?.split("|")
          .find((p) => p.startsWith("title="))
          ?.slice("title=".length);
        return title ? `\n*${title}*\n` : "\n";
      })
      .replace(PANEL_CLOSE, "\n")
      .replace(DROPPED_MACROS, "");

    // Group consecutive lines of the same kind; blocks of different kinds
    // (and separate block elements) are separated by a blank line.
    const groups: { kind: Kind; lines: string[] }[] = [];
    for (const raw of prepared.split("\n")) {
      const line = raw.trim();
      const kind = this.classify(line);
      const last = groups.at(-1);
      if (last?.kind === kind && kind !== "block") {
        last.lines.push(line);
      } else {
        groups.push({ kind, lines: [line] });
      }
    }
    const markdown = groups
      .filter((group) => group.kind !== "blank")
      .map((group) => this.render(group.kind, group.lines).join("\n"))
      .join("\n\n");
    return this.restore(markdown);
  }
}

export const jiraToMarkdown = (markup: string): string =>
  new Converter().convert(markup);
