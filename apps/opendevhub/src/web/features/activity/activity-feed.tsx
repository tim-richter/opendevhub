import { ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

import type { ActivityEvent, ActivityFilter } from "../../../shared/activity";
import { muted, Section } from "../../components/page";
import { When } from "../../components/when";
import { useDash } from "../../dashboard-context";
import { Link } from "../../routing";
import { forgejoRoute } from "../forgejo/forgejo";
import { eventLink, eventText } from "./activity";
import { ENTITY_ICON, ENTITY_NAME } from "./entity-icons";
import { useActivity } from "./use-activity";

/** One event: its entity's icon, what happened as a link to the entity, the project when the feed spans several. */
export const ActivityRow = (props: {
  event: ActivityEvent;
  showProject?: boolean;
}) => {
  const { forgejo } = useDash();
  const { event: e } = props;
  const Icon = ENTITY_ICON[e.object.type];
  const text = eventText(e);
  const link = eventLink(e);
  const internal =
    link && "external" in link
      ? forgejoRoute(link.external, forgejo?.enabled ? forgejo.url : undefined)
      : link?.href;
  let body = <span>{text}</span>;
  if (internal) {
    body = (
      <Link to={internal} className="hover:underline">
        {text}
      </Link>
    );
  } else if (link && "external" in link) {
    body = (
      <a
        href={link.external}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 hover:underline"
      >
        {text}
        <ExternalLinkIcon className="text-muted-foreground size-3" />
      </a>
    );
  }
  return (
    <li className="flex min-w-0 items-start gap-3 px-4 py-2.5 text-sm">
      <Icon
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
        aria-label={ENTITY_NAME[e.object.type]}
      />
      <div className="min-w-0 flex-1 break-words">
        {body}
        {props.showProject && e.projectName && (
          <span className="text-muted-foreground"> · {e.projectName}</span>
        )}
      </div>
      <When
        at={e.at}
        className="text-muted-foreground shrink-0 text-xs whitespace-nowrap"
      />
    </li>
  );
};

/**
 * A live feed of events, newest first: the first page follows the snapshot, older ones load when the end of the list
 * scrolls into view or on "Load more".
 */
export const ActivityFeed = (props: {
  filter: ActivityFilter;
  title?: string;
  /** Name each event's project, for a feed across projects. */
  showProject?: boolean;
  empty?: string;
  className?: string;
}) => {
  const feed = useActivity(props.filter);
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasMore, loadMore, loadingMore } = feed;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !hasMore || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadMore();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadMore, loadingMore]);

  let content;
  if (feed.isLoading) {
    content = (
      <div className="flex flex-col gap-3 px-4 py-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    );
  } else if (feed.error) {
    content = (
      <p className="text-destructive px-4 py-3 text-sm">
        {feed.error instanceof Error ? feed.error.message : String(feed.error)}
      </p>
    );
  } else if (feed.events.length === 0) {
    content = (
      <p className={cn(muted, "px-4 py-3")}>
        {props.empty ?? "Nothing has happened yet."}
      </p>
    );
  } else {
    content = (
      <>
        <ol className="divide-y" aria-label={props.title ?? "Activity"}>
          {feed.events.map((e) => (
            <ActivityRow key={e.id} event={e} showProject={props.showProject} />
          ))}
        </ol>
        {hasMore && (
          <div ref={sentinel} className="border-t px-4 py-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore && <LoaderCircleIcon className="animate-spin" />}
              Load more
            </Button>
          </div>
        )}
      </>
    );
  }
  return (
    <Section title={props.title ?? "Activity"} className={props.className}>
      {content}
    </Section>
  );
};
