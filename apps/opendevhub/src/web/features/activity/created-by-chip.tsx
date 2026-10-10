import { ExternalLinkIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";
import { taskPath } from "../tasks/tasks";
import { originLabel } from "./activity";
import type { Origin } from "./activity";
import { ENTITY_ICON } from "./entity-icons";

/** "Created by" for list rows: the task and variant, a manual action, a PR checkout, or outside opendevhub. */
export const CreatedByChip = (props: { origin: Origin; projectId: string }) => {
  const { forgejo } = useDash();
  const { origin } = props;
  const label = originLabel(origin, forgejo?.enabled ? forgejo.url : undefined);
  const href =
    origin.by === "variant" || origin.by === "session"
      ? taskPath(props.projectId, origin.task)
      : label.href;
  const Icon =
    origin.by === "pull" ? ENTITY_ICON.pull_request : ENTITY_ICON.task;
  const title = `Created by: ${label.text}`;
  const content = (
    <>
      {origin.by !== "manual" && origin.by !== "unmanaged" && (
        <Icon className="size-3" />
      )}
      <span className="max-w-48 truncate">{label.text}</span>
    </>
  );
  if (href) {
    return (
      <Badge
        variant="outline"
        asChild
        className="gap-1 font-sans font-normal"
        title={title}
      >
        <Link to={href}>{content}</Link>
      </Badge>
    );
  }
  if (label.external) {
    return (
      <Badge
        variant="outline"
        asChild
        className="gap-1 font-sans font-normal"
        title={title}
      >
        <a href={label.external} target="_blank" rel="noopener noreferrer">
          {content}
          <ExternalLinkIcon className="size-3" />
        </a>
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-muted-foreground gap-1 font-sans font-normal"
      title={title}
    >
      {content}
    </Badge>
  );
};
