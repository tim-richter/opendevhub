import type { ComponentPropsWithoutRef } from "react";
import Markdown from "react-markdown";
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

/** Render user-authored text (PR bodies, comments, Jira descriptions) as markdown. */
export const MarkdownBody = ({
  children,
  className,
}: {
  children: string;
  className?: string;
}) => (
  <div className={cn(STYLES, className)}>
    <Markdown components={components} remarkPlugins={remarkPlugins}>
      {children}
    </Markdown>
  </div>
);
