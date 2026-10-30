import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@opendevhub/ui/code-block";
import { getHighlighterIfLoaded, getSharedHighlighter } from "@pierre/diffs";
import type { ThemedToken } from "@pierre/diffs";
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

/** The diff views' themes, so code in markdown is colored like code in a diff. */
const THEMES = { dark: "pierre-dark", light: "pierre-light" } as const;

/** Languages that are plain text anyway; skips loading the highlighter for them. */
const PLAIN = new Set(["", "text", "txt", "plaintext", "plain"]);

/** A token's colors for both themes as CSS variables; the class below picks the one for the color scheme. */
const tokenStyle = (token: ThemedToken): CSSProperties =>
  Object.fromEntries(
    Object.entries(token.htmlStyle ?? {}).filter(([key]) =>
      key.startsWith("--")
    )
  );

/**
 * The code's lines as tokens once the shared highlighter has the language, undefined until then and for a language
 * Shiki doesn't know. Highlights synchronously when it's loaded, so streamed code doesn't flash back to plain text.
 */
const useTokens = (code: string, language: string) => {
  const [failed, setFailed] = useState<string>();
  // Bumped when the highlighter finishes loading the language, to highlight with it.
  const [, setLoaded] = useState(0);
  const highlighter =
    PLAIN.has(language) || failed === language
      ? undefined
      : getHighlighterIfLoaded({ lang: language, theme: THEMES });

  useEffect(() => {
    if (PLAIN.has(language) || highlighter) {
      return;
    }
    let cancelled = false;
    getSharedHighlighter({
      langs: [language],
      themes: [THEMES.dark, THEMES.light],
    })
      .then(() => {
        if (!cancelled) {
          setLoaded((n) => n + 1);
        }
      })
      .catch(() => {
        // An unknown language stays plain text.
        if (!cancelled) {
          setFailed(language);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [highlighter, language]);

  return useMemo(
    () =>
      highlighter?.codeToTokens(code, {
        defaultColor: false,
        lang: language,
        themes: THEMES,
      }).tokens,
    [highlighter, code, language]
  );
};

/** A fenced code block from markdown: highlighted when it names a language, with a button to copy it. */
export const CodeFence = ({
  code,
  language,
}: {
  code: string;
  /** The fence's info string, e.g. `ts`; empty when it has none. */
  language: string;
}) => {
  const source = code.replace(/\n$/u, "");
  const lang = language.toLowerCase();
  const tokens = useTokens(source, lang);
  const copy = <CodeBlockCopyButton value={source} />;

  return (
    <CodeBlock size="sm" className="not-prose my-3">
      {PLAIN.has(lang) ? (
        <CodeBlockActions>{copy}</CodeBlockActions>
      ) : (
        <CodeBlockHeader>
          <CodeBlockTitle className="font-mono font-normal">
            {language}
          </CodeBlockTitle>
          <CodeBlockActions>{copy}</CodeBlockActions>
        </CodeBlockHeader>
      )}
      <CodeBlockContent>
        {tokens
          ? tokens.map((line, index) => (
              // Lines have no identity beyond their position.
              // oxlint-disable-next-line react/no-array-index-key
              <CodeBlockLine key={index}>
                {line.map((token) => (
                  <span
                    key={token.offset}
                    style={tokenStyle(token)}
                    className="text-(--shiki-light) dark:text-(--shiki-dark)"
                  >
                    {token.content}
                  </span>
                ))}
              </CodeBlockLine>
            ))
          : source}
      </CodeBlockContent>
    </CodeBlock>
  );
};
