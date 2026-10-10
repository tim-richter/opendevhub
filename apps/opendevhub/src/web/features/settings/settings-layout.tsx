import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A settings section's heading: its title, what it's for, and an optional action such as Refresh. */
export const SettingsHeader = (props: {
  title: ReactNode;
  description: ReactNode;
  action?: ReactNode;
}) => (
  <header className="flex flex-wrap items-start justify-between gap-3">
    <div className="flex min-w-0 flex-col gap-1">
      <h1 className="text-xl font-semibold tracking-tight">{props.title}</h1>
      <p className="text-muted-foreground text-sm">{props.description}</p>
    </div>
    {props.action}
  </header>
);

/** One topic within a section; blocks after the first are set off by a rule. */
export const SettingsBlock = (props: {
  id?: string;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <section
    id={props.id}
    className={cn(
      "flex scroll-mt-6 flex-col gap-4 border-t pt-6 first:border-t-0 first:pt-0",
      props.className
    )}
  >
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="font-semibold">{props.title}</h2>
        {props.hint && (
          <p className="text-muted-foreground text-sm">{props.hint}</p>
        )}
      </div>
      {props.action}
    </div>
    {props.children}
  </section>
);

/** A label and its explanation on the left, the control on the right. */
export const SettingRow = (props: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) => (
  <div className="flex items-center justify-between gap-6">
    <div className="flex min-w-0 flex-col gap-0.5">
      <label htmlFor={props.htmlFor} className="text-sm font-medium">
        {props.label}
      </label>
      {props.description && (
        <p className="text-muted-foreground text-sm">{props.description}</p>
      )}
    </div>
    <div className="shrink-0">{props.children}</div>
  </div>
);

/** A bordered list whose rows are divided by rules. */
export const SettingsList = (props: {
  children: ReactNode;
  className?: string;
}) => (
  <ul
    className={cn(
      "bg-card flex flex-col divide-y rounded-lg border",
      props.className
    )}
  >
    {props.children}
  </ul>
);
