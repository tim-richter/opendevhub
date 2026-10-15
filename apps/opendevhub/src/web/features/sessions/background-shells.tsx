import { Button } from "@opendevhub/ui/button";
import { SquareIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";

import type { SessionSummary } from "../../../shared/types";
import { killShell } from "../../api";
import { Chip } from "../../components/page";
import { Tip } from "../../components/tip";
import { When } from "../../components/when";
import { useDash } from "../../dashboard-context";

/** "2 running" beside a conversation whose agents left shell commands running in the background. */
export const ShellsChip = ({ session }: { session: SessionSummary }) => {
  const count = session.shells?.length ?? 0;
  if (count === 0) {
    return null;
  }
  return (
    <Chip
      className="gap-1"
      title={session.shells?.map((shell) => shell.command).join("\n")}
    >
      <TerminalIcon className="size-3" aria-hidden />
      {count} running
    </Chip>
  );
};

/** The shell commands a conversation left running in the background, each with a button that kills it. */
export const BackgroundShells = ({ session }: { session: SessionSummary }) => {
  const { report } = useDash();
  const [killing, setKilling] = useState<ReadonlySet<string>>(new Set());
  const shells = session.shells ?? [];
  if (shells.length === 0) {
    return null;
  }
  const kill = (shellId: string) => {
    setKilling((current) => new Set(current).add(shellId));
    killShell(session.projectId, session.id, shellId)
      .catch(report)
      .finally(() =>
        setKilling((current) => {
          const next = new Set(current);
          next.delete(shellId);
          return next;
        })
      );
  };
  return (
    <section
      aria-label="Commands running in the background"
      className="flex shrink-0 items-center gap-2 border-b py-2 text-xs"
    >
      <span className="text-muted-foreground shrink-0 font-medium">
        Running ({shells.length})
      </span>
      <ul className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
        {shells.map((shell) => (
          <li
            key={shell.id}
            className="inline-flex max-w-80 shrink-0 items-center gap-1.5 rounded-md border py-0.5 pr-0.5 pl-2"
          >
            <TerminalIcon
              className="text-muted-foreground size-3 shrink-0"
              aria-hidden
            />
            <code className="truncate" title={shell.command}>
              {shell.command}
            </code>
            <When
              at={shell.startedAt}
              className="text-muted-foreground shrink-0"
            />
            <Tip label="Kill command">
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={`Kill ${shell.command}`}
                disabled={killing.has(shell.id)}
                onClick={() => kill(shell.id)}
              >
                <SquareIcon className="size-3" />
              </Button>
            </Tip>
          </li>
        ))}
      </ul>
    </section>
  );
};
