import { useEffect, useRef, useState } from "react";
import { CopyButton } from "./CopyButton";

export function LogPanel({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines, follow]);
  return (
    <div className="log-wrap">
      <div className="log-toolbar">
        <span className="muted">{lines.length} lines</span>
        <label className="toggle">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <CopyButton text={lines.join("\n")} label="Copy log" />
      </div>
      <pre
        className="logs"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {lines.length > 0 ? lines.join("\n") : "No output yet."}
      </pre>
    </div>
  );
}
