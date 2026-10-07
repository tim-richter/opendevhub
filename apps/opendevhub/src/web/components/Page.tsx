import type { ComponentProps, ReactNode } from "react";
import { NavLink } from "react-router";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export const Page = ({ className, ...props }: ComponentProps<"div">) => (
  <div
    className={cn("mx-auto flex max-w-6xl flex-col gap-6", className)}
    {...props}
  />
);

export const PageHeader = (props: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) => (
  <header
    className={cn(
      "flex flex-wrap items-start justify-between gap-4",
      props.className
    )}
  >
    <div className="flex min-w-0 flex-col gap-1">
      <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
        {props.title}
      </h1>
      {props.description && (
        <div className="text-muted-foreground text-sm">{props.description}</div>
      )}
    </div>
    {props.actions && (
      <div className="flex flex-wrap items-center gap-2 max-md:w-full">
        {props.actions}
      </div>
    )}
  </header>
);

export const Empty = (props: { title: ReactNode; children?: ReactNode }) => (
  <div className="bg-card flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-12 text-center">
    <h2 className="font-semibold">{props.title}</h2>
    {props.children}
  </div>
);

/** A card with a header row, holding a list or table flush to its edges. */
export const Section = (props: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  attention?: boolean;
  children: ReactNode;
  className?: string;
}) => (
  <Card
    className={cn(
      "gap-0 overflow-hidden py-0",
      props.attention && "border-attention/50",
      props.className
    )}
  >
    <div
      className={cn(
        "flex items-baseline gap-3 border-b px-4 py-3",
        props.attention && "bg-attention/5"
      )}
    >
      <h2 className={cn("font-semibold", props.attention && "text-attention")}>
        {props.title}
      </h2>
      {props.hint && (
        <span className="text-muted-foreground text-sm">{props.hint}</span>
      )}
      {props.action && <div className="ml-auto">{props.action}</div>}
    </div>
    {props.children}
  </Card>
);

/** A single-choice filter drawn as a segmented control. */
export const Segmented = <T extends string>(props: {
  value: T;
  options: { id: T; label: ReactNode }[];
  onChange: (id: T) => void;
  label?: string;
}) => (
  <Tabs value={props.value} onValueChange={(v) => props.onChange(v as T)}>
    <TabsList aria-label={props.label}>
      {props.options.map((o) => (
        <TabsTrigger key={o.id} value={o.id}>
          {o.label}
        </TabsTrigger>
      ))}
    </TabsList>
  </Tabs>
);

export const Chip = ({ className, ...props }: ComponentProps<typeof Badge>) => (
  <Badge
    variant="secondary"
    className={cn(
      "bg-muted text-muted-foreground rounded-md px-1.5 align-middle font-normal",
      className
    )}
    {...props}
  />
);

/** Small uppercase heading above a group of rows. */
export const GroupTitle = (props: {
  children: ReactNode;
  className?: string;
}) => (
  <h3
    className={cn(
      "text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase",
      props.className
    )}
  >
    {props.children}
  </h3>
);

/** A quiet inline notice; `warn` tints it. */
export const Note = (props: {
  warn?: boolean;
  children: ReactNode;
  className?: string;
}) => (
  <p
    className={cn(
      "bg-muted text-muted-foreground rounded-lg px-3 py-2 text-sm",
      props.warn && "bg-warn/10 text-warn",
      props.className
    )}
  >
    {props.children}
  </p>
);

export const muted = "text-sm text-muted-foreground";

/** Hands @pierre/diffs (which renders in shadow DOM) the dashboard's monospace font. */
export const diffFont =
  "[--diffs-font-family:var(--font-mono)] [--diffs-font-size:12px] [--diffs-header-font-family:var(--font-mono)]";

/** A tab in an underlined tab bar that is also a route. */
export const TabLink = (props: {
  to: string;
  end?: boolean;
  children: ReactNode;
}) => (
  <NavLink
    to={props.to}
    end={props.end}
    className={({ isActive }) =>
      cn(
        "inline-flex items-center gap-1.5 border-b-2 px-0.5 py-2 text-sm font-medium whitespace-nowrap transition-colors",
        isActive
          ? "border-foreground text-foreground"
          : "text-muted-foreground hover:text-foreground border-transparent"
      )
    }
  >
    {props.children}
  </NavLink>
);

export const TabBar = (props: { children: ReactNode; label?: string }) => (
  <nav
    aria-label={props.label}
    className="-mb-2 flex gap-5 overflow-x-auto shadow-[inset_0_-1px_var(--border)]"
  >
    {props.children}
  </nav>
);
