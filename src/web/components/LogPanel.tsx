import { useEffect, useRef } from "react";

export function LogPanel({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines]);
  return (
    <pre className="logs" ref={ref}>
      {lines.length > 0 ? lines.join("\n") : "No output yet."}
    </pre>
  );
}
