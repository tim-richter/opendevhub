import { useEffect, useMemo, useRef, useState } from "react";
import { CopyButton } from "./CopyButton";

const VISIBLE_LINES = 300;

export function LogPanel({ lines }: { lines: string[] }) {
  const all = useMemo(() => lines.join("\n"), [lines]);
  const shown = useMemo(() => lines.slice(-VISIBLE_LINES).join("\n"), [lines]);
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines, follow]);
  return (
    <div className="log-wrap">
      <div className="log-toolbar">
        <span className="muted">
          {lines.length > VISIBLE_LINES ? `last ${VISIBLE_LINES} of ${lines.length} lines` : `${lines.length} lines`}
        </span>
        <label className="toggle">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
        </label>
        <CopyButton text={all} label="Copy log" />
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
        {lines.length > 0 ? shown : "No output yet."}
      </pre>
    </div>
  );
}
