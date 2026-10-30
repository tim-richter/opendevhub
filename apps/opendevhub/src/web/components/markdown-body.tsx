import { createContext, createElement, useContext, useMemo } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Markdown from "react-markdown";
import type { ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../lib/utils";
import { CodeFence } from "./code-fence";

const ExternalLink = (props: ComponentPropsWithoutRef<"a">) => (
  // oxlint-disable-next-line jsx-a11y/anchor-has-content -- content comes from props
  <a {...props} target="_blank" rel="noopener noreferrer" />
);

type HastNode = NonNullable<ExtraProps["node"]>["children"][number];

const textOf = (node: HastNode): string => {
  if (node.type === "text") {
    return node.value;
  }
  return "children" in node ? node.children.map(textOf).join("") : "";
};

const LANGUAGE_CLASS = /^language-(?<lang>.+)$/u;

/** A fenced code block, rendered as a code block with highlighting and a copy button; other `pre`s stay as they are. */
const Pre = ({
  node,
  ...props
}: ComponentPropsWithoutRef<"pre"> & ExtraProps) => {
  const code = node?.children.find(
    (child) => child.type === "element" && child.tagName === "code"
  );
  if (!code || code.type !== "element") {
    return <pre {...props} />;
  }
  const classes = code.properties.className;
  const language = (Array.isArray(classes) ? classes : [])
    .map((name) => LANGUAGE_CLASS.exec(String(name))?.groups?.lang)
    .find(Boolean);
  return <CodeFence code={textOf(code)} language={language ?? ""} />;
};

const components = { a: ExternalLink, pre: Pre };

interface MdastParent {
  children: { type: string; value?: string; children?: unknown[] }[];
}

/** Raw HTML that is nothing but comments, e.g. a tool's `<!-- branch-stack-start -->` marker. */
const HTML_COMMENTS = /^(?:\s*<!--[\s\S]*?-->)+\s*$/u;

/** Drops HTML comments, which would otherwise render as literal text since raw HTML isn't interpreted. */
const stripHtmlComments = () => (tree: MdastParent) => {
  const strip = (parent: MdastParent) => {
    parent.children = parent.children.filter(
      (child) =>
        !(child.type === "html" && HTML_COMMENTS.test(child.value ?? ""))
    );
    for (const child of parent.children) {
      if (child.children) {
        strip(child as MdastParent);
      }
    }
  };
  strip(tree);
};
const remarkPlugins = [remarkGfm, stripHtmlComments];

/** Typography plugin tweaks: GitHub-style heading rules and inline code without backticks. */
const STYLES = [
  "prose prose-sm max-w-none break-words",
  "prose-headings:font-semibold",
  "prose-h1:border-b prose-h1:pb-1 prose-h2:border-b prose-h2:pb-1",
  "prose-a:underline",
  "prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:font-mono prose-code:text-xs prose-code:font-normal",
  "prose-code:before:content-none prose-code:after:content-none",
  "prose-pre:overflow-x-auto",
  "prose-img:max-w-full",
].join(" ");

/** A top-level block of the markdown (a paragraph, heading, list item, table…) by its source lines, 1-based. */
export interface MarkdownBlock {
  start: number;
  end: number;
  /** The block's source lines. */
  source: string[];
}

type HastElement = NonNullable<ExtraProps["node"]>;
interface HastParent {
  children: unknown[];
}

const isElement = (node: unknown): node is HastElement =>
  typeof node === "object" &&
  node !== null &&
  (node as { type?: unknown }).type === "element";

/** Marks the blocks a comment can anchor to: each top-level element, and each item of a top-level list. */
const markBlocks = () => (tree: HastParent) => {
  for (const child of tree.children) {
    if (!isElement(child) || child.tagName === "hr") {
      continue;
    }
    const items =
      child.tagName === "ul" || child.tagName === "ol"
        ? child.children.filter(isElement)
        : [child];
    for (const item of items) {
      item.properties.dataBlock = true;
    }
  }
};
const rehypePlugins = [markBlocks];

interface BlockContextValue {
  lines: string[];
  aside: (block: MarkdownBlock) => ReactNode;
}
const BlockContext = createContext<BlockContextValue | undefined>(undefined);

const BLOCK_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "table",
  "li",
] as const;
type BlockTag = (typeof BLOCK_TAGS)[number];

type BlockProps = ComponentPropsWithoutRef<"div"> & ExtraProps;

/** Renders a block element; a marked one gets the caller's aside (a comment button, its comments) next to it. */
const BlockElement = ({
  tag,
  node,
  ...props
}: BlockProps & { tag: BlockTag }) => {
  const context = useContext(BlockContext);
  const position = node?.position;
  const element =
    tag === "pre" ? (
      // The props are typed for a div so every block tag shares them; react-markdown gave them to a pre.
      <Pre node={node} {...(props as ComponentPropsWithoutRef<"pre">)} />
    ) : (
      createElement(tag, props)
    );
  if (!context || !position || node?.properties.dataBlock !== true) {
    return element;
  }
  const block: MarkdownBlock = {
    end: position.end.line,
    source: context.lines.slice(position.start.line - 1, position.end.line),
    start: position.start.line,
  };
  // A list item stays the list's child; anything else sits in a wrapper with the aside after it.
  if (tag === "li") {
    return createElement(
      "li",
      { ...props, className: cn(props.className, "group/block relative") },
      props.children,
      context.aside(block)
    );
  }
  return (
    <div className="group/block relative">
      {element}
      {context.aside(block)}
    </div>
  );
};

const blockComponents = {
  ...components,
  ...Object.fromEntries(
    BLOCK_TAGS.map((tag) => [
      tag,
      (props: BlockProps) => <BlockElement tag={tag} {...props} />,
    ])
  ),
};

/**
 * Render user-authored text (PR bodies, comments, Jira descriptions) as markdown. With `blockAside`, each top-level
 * block also renders what it returns for the block, e.g. a button to comment on it and the comments it has.
 */
export const MarkdownBody = ({
  children,
  className,
  blockAside,
}: {
  children: string;
  className?: string;
  blockAside?: (block: MarkdownBlock) => ReactNode;
}) => {
  const context = useMemo(
    () =>
      blockAside
        ? { aside: blockAside, lines: children.split("\n") }
        : undefined,
    [blockAside, children]
  );
  return (
    <div className={cn(STYLES, className)}>
      {context ? (
        <BlockContext.Provider value={context}>
          <Markdown
            components={blockComponents}
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
          >
            {children}
          </Markdown>
        </BlockContext.Provider>
      ) : (
        <Markdown components={components} remarkPlugins={remarkPlugins}>
          {children}
        </Markdown>
      )}
    </div>
  );
};
