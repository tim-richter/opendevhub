import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CopyButton } from "./CopyButton";

export function LogPanel({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines, follow]);
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <div className="flex items-center gap-4 border-b py-1.5 pr-2 pl-4 text-xs">
        <span className="text-muted-foreground">{lines.length} lines</span>
        <Label className="ml-auto text-xs font-normal text-muted-foreground">
          <Switch size="sm" checked={follow} onCheckedChange={setFollow} /> Follow
        </Label>
        <CopyButton text={lines.join("\n")} label="Copy log" />
      </div>
      <pre
        className="m-0 h-[calc(100vh-22rem)] min-h-64 overflow-auto bg-muted/40 px-4 py-3 font-mono text-xs/relaxed wrap-anywhere whitespace-pre-wrap"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {lines.length > 0 ? lines.join("\n") : "No output yet."}
      </pre>
    </Card>
  );
}
