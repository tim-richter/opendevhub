import { useQuery } from "@tanstack/react-query";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  LoaderCircleIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import { useDebouncedValue } from "../../hooks/use-debounced-value";
import { basePositionQuery } from "./base-queries";
import { baseStatus } from "./base-status";

const TYPING_MS = 300;

const ICONS = {
  muted: InfoIcon,
  ok: CircleCheckIcon,
  warn: CircleAlertIcon,
} as const;

/**
 * What starting the task will do with its base: update it from its remote first, start from it as it is, or why it
 * can't be updated. Follows the Base field once typing pauses; never blocks starting the task.
 */
export const BaseStatusLine = (props: {
  projectId: string;
  /** The Base field as typed; empty for the main checkout's branch. */
  base: string;
  id?: string;
}) => {
  const base = useDebouncedValue(props.base.trim(), TYPING_MS);
  const query = useQuery(basePositionQuery(props.projectId, base));
  let content: { text: string; tone: keyof typeof ICONS | "loading" };
  if (query.data) {
    content = baseStatus(query.data);
  } else if (query.error) {
    content = {
      text: `Couldn't read ${base || "the base"}: ${query.error.message}`,
      tone: "muted",
    };
  } else {
    content = {
      text: `Checking ${base || "the base"} against its remote…`,
      tone: "loading",
    };
  }
  const Icon =
    content.tone === "loading" ? LoaderCircleIcon : ICONS[content.tone];
  return (
    <p
      id={props.id}
      role="status"
      aria-live="polite"
      className={cn(
        "flex items-start gap-1.5 text-xs",
        content.tone === "warn" ? "text-warn" : "text-muted-foreground"
      )}
    >
      <Icon
        aria-hidden
        className={cn(
          "mt-px size-3.5 shrink-0",
          content.tone === "ok" && "text-ok",
          content.tone === "loading" && "animate-spin"
        )}
      />
      <span className="min-w-0 break-words">{content.text}</span>
    </p>
  );
};
