import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { Fragment } from "react";
import type { ReactNode } from "react";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";

import type {
  ObjectType,
  Provenance,
  ProvenanceStep,
} from "../../../shared/activity";
import { Link } from "../../routing";
import { ENTITY_ICON, ENTITY_NAME } from "./entity-icons";
import { useProvenance } from "./use-activity";

const stepTitle = (s: ProvenanceStep): string =>
  [
    ENTITY_NAME[s.type],
    s.removed ? "removed" : undefined,
    s.unmanaged ? "created outside opendevhub" : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

/** One step: a link to its page, or to its page on the forge or in Jira; removed ones struck through, unlinked. */
const Step = (props: { step: ProvenanceStep; current?: boolean }) => {
  const { step: s } = props;
  const Icon = ENTITY_ICON[s.type];
  const inner = (
    <>
      <Icon className="size-3.5 shrink-0" />
      <span className={cn("max-w-56 truncate", s.removed && "line-through")}>
        {s.label}
      </span>
      {s.unmanaged && (
        <span className="text-muted-foreground text-xs">(outside)</span>
      )}
    </>
  );
  const className = "inline-flex items-center gap-1";
  if (props.current) {
    return (
      <BreadcrumbPage className={className} title={stepTitle(s)}>
        {inner}
      </BreadcrumbPage>
    );
  }
  if (s.removed) {
    return (
      <span className={cn(className, "opacity-70")} title={stepTitle(s)}>
        {inner}
      </span>
    );
  }
  if (s.href) {
    return (
      <BreadcrumbLink asChild className={className} title={stepTitle(s)}>
        <Link to={s.href}>{inner}</Link>
      </BreadcrumbLink>
    );
  }
  if (s.url) {
    return (
      <BreadcrumbLink
        href={s.url}
        target="_blank"
        rel="noopener noreferrer"
        className={className}
        title={stepTitle(s)}
      >
        {inner}
        <ExternalLinkIcon className="size-3" />
      </BreadcrumbLink>
    );
  }
  return (
    <span className={className} title={stepTitle(s)}>
      {inner}
    </span>
  );
};

/** A trail from the outermost origin down to the entity, with what it led to after an arrow. */
export const ProvenanceTrail = (props: {
  provenance: Provenance;
  className?: string;
}) => {
  const { trail, ledTo } = props.provenance;
  return (
    <Breadcrumb className={props.className}>
      <BreadcrumbList className="gap-y-1 sm:gap-x-2">
        {trail.map((s, i) => (
          <Fragment key={`${s.type}:${s.id}`}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem>
              <Step step={s} current={i === trail.length - 1} />
            </BreadcrumbItem>
          </Fragment>
        ))}
        {ledTo.length > 0 && (
          <>
            <BreadcrumbSeparator>
              <ArrowRightIcon />
            </BreadcrumbSeparator>
            {ledTo.map((s, i) => (
              <BreadcrumbItem key={`${s.type}:${s.id}`}>
                {i > 0 && <span aria-hidden="true">·</span>}
                <Step step={s} />
              </BreadcrumbItem>
            ))}
          </>
        )}
      </BreadcrumbList>
    </Breadcrumb>
  );
};

/** The entity's provenance as a breadcrumb; `fallback` while it loads or when opendevhub has no record of it. */
export const ProvenanceBreadcrumb = (props: {
  type: ObjectType;
  id: string | undefined;
  className?: string;
  fallback?: ReactNode;
}) => {
  const { data } = useProvenance(props.type, props.id);
  if (!data || data.trail.length === 0) {
    return props.fallback ?? null;
  }
  return <ProvenanceTrail provenance={data} className={props.className} />;
};
