import { useState } from "react";
import { Icon } from "./Icon";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="icon-button"
      title={done ? "Copied" : label}
      aria-label={label}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
    >
      <Icon name={done ? "check" : "copy"} size={14} />
    </button>
  );
}
