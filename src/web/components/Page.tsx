import type { ComponentProps, ReactNode } from "react";
import { NavLink } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

export function Page({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("mx-auto flex max-w-6xl flex-col gap-6", className)} {...props} />;
}

export function PageHeader(props: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex flex-wrap items-start justify-between gap-4", props.className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">{props.title}</h1>
        {props.description && <div className="text-sm text-muted-foreground">{props.description}</div>}
      </div>
      {props.actions && <div className="flex flex-wrap items-center gap-2 max-md:w-full">{props.actions}</div>}
    </header>
  );
}

export function Empty(props: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-card px-4 py-12 text-center">
      <h2 className="font-semibold">{props.title}</h2>
      {props.children}
    </div>
  );
}

/** A card with a header row, holding a list or table flush to its edges. */
export function Section(props: { title: ReactNode; hint?: ReactNode; action?: ReactNode; attention?: boolean; children: ReactNode; className?: string }) {
  return (
    <Card className={cn("gap-0 overflow-hidden py-0", props.attention && "border-attention/50", props.className)}>
      <div className={cn("flex items-baseline gap-3 border-b px-4 py-3", props.attention && "bg-attention/5")}>
        <h2 className={cn("font-semibold", props.attention && "text-attention")}>{props.title}</h2>
        {props.hint && <span className="text-sm text-muted-foreground">{props.hint}</span>}
        {props.action && <div className="ml-auto">{props.action}</div>}
      </div>
      {props.children}
    </Card>
  );
}

/** A single-choice filter drawn as a segmented control. */
export function Segmented<T extends string>(props: { value: T; options: { id: T; label: ReactNode }[]; onChange: (id: T) => void; label?: string }) {
  return (
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
}

export function Chip({ className, ...props }: ComponentProps<typeof Badge>) {
  return <Badge variant="secondary" className={cn("rounded-md bg-muted px-1.5 align-middle font-normal text-muted-foreground", className)} {...props} />;
}

/** Small uppercase heading above a group of rows. */
export function GroupTitle(props: { children: ReactNode; className?: string }) {
  return <h3 className={cn("mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase", props.className)}>{props.children}</h3>;
}

/** A quiet inline notice; `warn` tints it. */
export function Note(props: { warn?: boolean; children: ReactNode; className?: string }) {
  return (
    <p className={cn("rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground", props.warn && "bg-warn/10 text-warn", props.className)}>
      {props.children}
    </p>
  );
}

export const muted = "text-sm text-muted-foreground";

/** Hands @pierre/diffs (which renders in shadow DOM) the dashboard's monospace font. */
export const diffFont = "[--diffs-font-family:var(--font-mono)] [--diffs-font-size:12px] [--diffs-header-font-family:var(--font-mono)]";

/** A tab in an underlined tab bar that is also a route. */
export function TabLink(props: { to: string; end?: boolean; children: ReactNode }) {
  return (
    <NavLink
      to={props.to}
      end={props.end}
      className={({ isActive }) =>
        cn(
          "inline-flex items-center gap-1.5 border-b-2 px-0.5 py-2 text-sm font-medium whitespace-nowrap transition-colors",
          isActive ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
        )
      }
    >
      {props.children}
    </NavLink>
  );
}

export function TabBar(props: { children: ReactNode; label?: string }) {
  return (
    <nav aria-label={props.label} className="-mb-2 flex gap-5 overflow-x-auto shadow-[inset_0_-1px_var(--border)]">
      {props.children}
    </nav>
  );
}
