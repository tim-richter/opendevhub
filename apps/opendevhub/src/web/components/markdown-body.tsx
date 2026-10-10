import { createContext, createElement, useContext, useMemo } from "react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import Markdown from "react-markdown";
import type { ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../lib/utils";

const ExternalLink = (props: ComponentPropsWithoutRef<"a">) => (
  // oxlint-disable-next-line jsx-a11y/anchor-has-content -- content comes from props
  <a {...props} target="_blank" rel="noopener noreferrer" />
);

const components = { a: ExternalLink };
const remarkPlugins = [remarkGfm];

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
  if (!context || !position || node?.properties.dataBlock !== true) {
    return createElement(tag, props);
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
      {createElement(tag, props)}
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
