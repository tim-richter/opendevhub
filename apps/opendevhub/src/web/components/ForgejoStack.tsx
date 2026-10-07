import { CornerDownRightIcon, GitBranchIcon } from "lucide-react";
import { Link } from "react-router";

import type { ForgejoPullDetails } from "../../shared/forgejo";
import { forgejoStackRows } from "../forgejo";
import { Section } from "./Page";

/** Extra left padding per level of the stack. */
const STACK_INDENT_REM = 1.5;

/** The open pull requests this one builds on and those built on it, each linking to its own page. */
export const ForgejoStack = ({
  details,
  search,
}: {
  details: ForgejoPullDetails;
  /** The pull request list's filters, kept so "back" from a stacked pull request returns to the same view. */
  search: string;
}) => {
  const rows = forgejoStackRows(details);
  if (!rows.length) {
    return null;
  }
  const { owner, repo } = details.pull;
  const bottom = details.stack?.ancestors[0]?.base ?? details.base;
  return (
    <Section title="Stack" hint={`${rows.length} pull requests`}>
      <ol className="divide-y text-sm">
        <li className="text-muted-foreground flex items-center gap-2 px-4 py-2">
          <GitBranchIcon className="size-4 shrink-0" />
          <code className="text-xs">{bottom}</code>
        </li>
        {rows.map((row) => (
          <li
            key={row.number}
            style={{ paddingLeft: `${1 + row.depth * STACK_INDENT_REM}rem` }}
            className="flex items-start gap-2 py-2 pr-4"
          >
            <CornerDownRightIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
            {row.current ? (
              <span aria-current="page" className="min-w-0 break-words">
                <span className="font-medium">
                  #{row.number} {row.title}
                </span>{" "}
                <span className="text-muted-foreground">
                  (this pull request)
                </span>
              </span>
            ) : (
              <Link
                className="min-w-0 break-words hover:underline"
                to={`/forgejo/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${row.number}${search ? `?${search}` : ""}`}
              >
                #{row.number} {row.title}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Section>
  );
};
