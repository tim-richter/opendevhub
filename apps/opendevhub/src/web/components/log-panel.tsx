import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { CopyButton } from "./copy-button";

export const LogPanel = ({
  lines,
  hint,
}: {
  lines: string[];
  hint?: ReactNode;
}) => {
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow) {
      ref.current?.scrollTo({ top: ref.current.scrollHeight });
    }
  }, [lines, follow]);
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Logs</h2>
          <p className="text-muted-foreground text-sm">
            {hint ?? `${lines.length} lines`}
          </p>
        </div>
        <Label className="text-muted-foreground ml-auto text-sm font-normal">
          <Switch size="sm" checked={follow} onCheckedChange={setFollow} />{" "}
          Follow
        </Label>
        <CopyButton text={lines.join("\n")} label="Copy log" />
      </div>
      <Card className="gap-0 overflow-hidden py-0">
        <pre
          className="bg-muted/40 m-0 h-[calc(100vh-22rem)] min-h-64 overflow-auto px-4 py-3 font-mono text-xs/relaxed wrap-anywhere whitespace-pre-wrap"
          ref={ref}
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom =
              el.scrollHeight - el.scrollTop - el.clientHeight < 8;
            if (atBottom !== follow) {
              setFollow(atBottom);
            }
          }}
        >
          {lines.length > 0 ? lines.join("\n") : "No output yet."}
        </pre>
      </Card>
    </section>
  );
};
