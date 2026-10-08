import { ExternalLinkIcon } from "lucide-react";
import { Fragment, useCallback, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";

import type {
  FormField,
  PendingForm,
  PendingPermission,
  PermissionDecision,
  ProjectView,
  SessionSummary,
} from "../../shared/types";
import { dismissForm, replyForm, replyPermission } from "../api";
import type { ReplyOutcome } from "../api";
import { canTakeFocus, cardAction } from "../card-keys";
import type { CardAction } from "../card-keys";
import { sessionHref } from "../derive";
import {
  buildAnswer,
  fieldLabel,
  formSupported,
  initialValues,
  inputType,
  isVisible,
  optionsOf,
  safeUrl,
} from "../forms";
import type { FieldValue, FormValues } from "../forms";
import { ensurePatchHeader } from "../review";
import { Choice } from "./choice";
import { PatchView } from "./lazy-patch-view";
import { diffFont } from "./page";

const RESOURCE_LIMIT = 5;
const RADIO_LIMIT = 5;

type Item =
  | { kind: "permission"; item: PendingPermission }
  | { kind: "form"; item: PendingForm };

/**
 * The card's shortcut keys. Keys only count while the card itself has focus (never while typing in one of
 * its fields), and not while the card has just appeared. j/k move between cards and are handled here.
 */
const useCardKeys = (onAction: (action: CardAction) => void) => {
  const mountedAt = useRef(Date.now());
  return (e: KeyboardEvent<HTMLElement>) => {
    const action = cardAction(
      {
        key: e.key,
        modified: e.metaKey || e.ctrlKey || e.altKey,
        onCard: e.target === e.currentTarget,
        repeat: e.repeat,
      },
      mountedAt.current,
      Date.now()
    );
    if (!action) {
      return;
    }
    e.preventDefault();
    if (action === "next" || action === "prev") {
      const cards = [
        ...document.querySelectorAll<HTMLElement>("[data-pending-card]"),
      ];
      cards[
        cards.indexOf(e.currentTarget) + (action === "next" ? 1 : -1)
      ]?.focus();
    } else {
      onAction(action);
    }
  };
};

/** Focuses the card when it mounts if the stack hands it focus, so answering by keyboard lands on the next card. */
const useAutoFocus = (takeFocus: () => boolean) =>
  useCallback(
    (el: HTMLElement | null) => {
      if (el && takeFocus()) {
        el.focus();
      }
    },
    [takeFocus]
  );

const useReply = (onDone: () => void) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = (send: () => Promise<ReplyOutcome>) => {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    send().then(onDone, (err) => {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    });
  };
  return { busy, error, run };
};

/** What one session waits on, oldest first. Only the oldest is shown; answering it reveals the next. */
export const PendingStack = (props: {
  session: SessionSummary;
  view: ProjectView;
}) => {
  const { session, view } = props;
  const [answered, setAnswered] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  // One-shot: set when an item is answered while focus was in this stack; the next card claims it on mount.
  const focusClaim = useRef(false);
  const stack = useRef<HTMLDivElement>(null);
  const takeFocus = useCallback(() => {
    const claimed = focusClaim.current;
    focusClaim.current = false;
    return (
      claimed &&
      canTakeFocus<Element>(
        document.activeElement,
        document.body,
        stack.current
      )
    );
  }, []);
  const items: Item[] = [
    ...(session.pending?.permissions ?? []).map((item) => ({
      item,
      kind: "permission" as const,
    })),
    ...(session.pending?.forms ?? []).map((item) => ({
      item,
      kind: "form" as const,
    })),
  ]
    .filter((i) => !answered.has(i.item.id))
    .toSorted((a, b) => (a.item.createdAt ?? 0) - (b.item.createdAt ?? 0));
  if (items.length === 0) {
    return null;
  }

  const [current] = items;
  const done = () => {
    focusClaim.current =
      stack.current?.contains(document.activeElement) ?? false;
    setAnswered((prev) => new Set(prev).add(current.item.id));
  };
  return (
    <div ref={stack}>
      {items.length > 1 && (
        <p className="text-muted-foreground mb-1.5 text-xs">
          1 of {items.length} waiting
        </p>
      )}
      {current.kind === "permission" ? (
        <PermissionCard
          key={current.item.id}
          projectId={view.project.id}
          sessionTitle={session.title}
          permission={current.item}
          takeFocus={takeFocus}
          onDone={done}
        />
      ) : (
        <FormCard
          key={current.item.id}
          projectId={view.project.id}
          form={current.item}
          openUrl={sessionHref(view, session)}
          takeFocus={takeFocus}
          onDone={done}
        />
      )}
    </div>
  );
};

const PermissionCard = (props: {
  projectId: string;
  sessionTitle: string;
  permission: PendingPermission;
  takeFocus: () => boolean;
  onDone: () => void;
}) => {
  const { permission: p } = props;
  const { busy, error, run } = useReply(props.onDone);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const ref = useAutoFocus(props.takeFocus);
  const reply = (decision: PermissionDecision, message?: string) =>
    run(() => replyPermission(props.projectId, p.id, decision, message));

  const onKeyDown = useCardKeys((action) => {
    if (action === "reject") {
      setRejecting(true);
    } else {
      reply(action === "always" ? "always" : "once");
    }
  });

  const shown = p.resources.slice(0, RESOURCE_LIMIT);
  return (
    <section
      ref={ref}
      className={CARD}
      data-pending-card
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label={`${props.sessionTitle} wants ${p.action}`}
    >
      <p>
        <span className="text-muted-foreground">{props.sessionTitle}</span>{" "}
        wants <strong>{p.action}</strong>
      </p>
      {shown.length > 0 && (
        <ul className="flex flex-col gap-1">
          {shown.map((r, i) => (
            <li key={i}>
              <code className="font-mono text-xs wrap-anywhere whitespace-pre-wrap">
                {r}
              </code>
            </li>
          ))}
          {p.resources.length > RESOURCE_LIMIT && (
            <li className="text-muted-foreground">
              +{p.resources.length - RESOURCE_LIMIT} more
            </li>
          )}
        </ul>
      )}
      {p.message && (
        <p className="wrap-anywhere whitespace-pre-wrap">{p.message}</p>
      )}
      {p.diff && (
        <div
          className={cn("max-h-72 overflow-auto rounded-md border", diffFont)}
        >
          <PatchView
            patch={ensurePatchHeader(p.diff, p.resources[0] ?? "change")}
          />
        </div>
      )}
      {rejecting ? (
        <form
          className={ACTIONS}
          onSubmit={(e) => {
            e.preventDefault();
            reply("reject", reason.trim() || undefined);
          }}
        >
          <Input
            autoFocus
            className="h-8 flex-[1_1_16rem]"
            placeholder="Reason for the agent (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setRejecting(false);
              }
            }}
          />
          <Button type="submit" variant="destructive" size="sm" disabled={busy}>
            Reject
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRejecting(false)}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <div className={ACTIONS}>
          <Button size="sm" disabled={busy} onClick={() => reply("once")}>
            Allow once{" "}
            <Kbd className="bg-primary-foreground/15 text-primary-foreground">
              ↵
            </Kbd>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            title={
              p.save?.length
                ? `Saves a rule for: ${p.save.join(", ")}`
                : "Allow this and future requests like it"
            }
            onClick={() => reply("always")}
          >
            Always allow <Kbd>a</Kbd>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setRejecting(true)}
          >
            Reject… <Kbd>r</Kbd>
          </Button>
        </div>
      )}
      {error && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </section>
  );
};

const FormCard = (props: {
  projectId: string;
  form: PendingForm;
  openUrl: string;
  takeFocus: () => boolean;
  onDone: () => void;
}) => {
  const { form } = props;
  const { busy, error, run } = useReply(props.onDone);
  const [values, setValues] = useState<FormValues>(() =>
    initialValues(form.fields)
  );
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ref = useAutoFocus(props.takeFocus);
  // Forms only use j/k; Enter in a form field submits the form natively.
  const onKeyDown = useCardKeys(() => undefined);

  if (!formSupported(form.fields)) {
    return (
      <section
        ref={ref}
        className={CARD}
        data-pending-card
        tabIndex={0}
        onKeyDown={onKeyDown}
        aria-label={form.title}
      >
        <p>{form.title}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          {form.fields.map((f) => (
            <Fragment key={f.key}>
              <dt>{fieldLabel(f)}</dt>
              <dd className="text-muted-foreground">{f.type}</dd>
            </Fragment>
          ))}
        </dl>
        <div className={ACTIONS}>
          <Button asChild size="sm">
            <a href={props.openUrl} target="_blank" rel="noreferrer">
              Answer in opencode <ExternalLinkIcon />
            </a>
          </Button>
        </div>
      </section>
    );
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const built = buildAnswer(form.fields, values, custom);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    run(() => replyForm(props.projectId, form.id, built.answer));
  };
  // opencode takes no reason when a form is cancelled, so Dismiss asks for none.
  const dismiss = () => run(() => dismissForm(props.projectId, form.id));

  return (
    <form
      ref={ref}
      className={CARD}
      data-pending-card
      tabIndex={0}
      onKeyDown={onKeyDown}
      onSubmit={submit}
      aria-label={form.title}
    >
      <p>{form.title}</p>
      {form.fields
        .filter((f) => isVisible(f, values))
        .map((f) => (
          <FieldControl
            key={f.key}
            name={`${form.id}-${f.key}`}
            field={f}
            value={values[f.key]}
            custom={custom[f.key] ?? ""}
            error={errors[f.key]}
            onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
            onCustom={(t) => setCustom((prev) => ({ ...prev, [f.key]: t }))}
          />
        ))}
      <div className={ACTIONS}>
        <Button type="submit" size="sm" disabled={busy}>
          Submit
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={dismiss}
        >
          Dismiss
        </Button>
      </div>
      {error && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </form>
  );
};

const FieldControl = (props: {
  name: string;
  field: FormField;
  value: FieldValue | undefined;
  custom: string;
  error?: string;
  onChange: (v: FieldValue) => void;
  onCustom: (text: string) => void;
}) => {
  const { field: f, value, name } = props;
  const label = fieldLabel(f);
  const text = typeof value === "string" ? value : "";
  let control: ReactNode;
  switch (f.type) {
    case "boolean": {
      control = (
        <Label className="font-normal">
          <Checkbox
            checked={value === true}
            onCheckedChange={(c) => props.onChange(c === true)}
          />{" "}
          Yes
        </Label>
      );
      break;
    }
    case "number":
    case "integer": {
      control = (
        <Input
          type="number"
          className="h-8 w-48"
          aria-label={label}
          step={f.type === "integer" ? 1 : "any"}
          min={f.minimum}
          max={f.maximum}
          required={f.required}
          value={text}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
      break;
    }
    case "multiselect": {
      const picked = Array.isArray(value) ? value : [];
      control = (
        <div className={CHOICES}>
          {optionsOf(f).map((o) => (
            <Label key={o.value} className="font-normal">
              <Checkbox
                checked={picked.includes(o.value)}
                onCheckedChange={(c) =>
                  props.onChange(
                    c === true
                      ? [...picked, o.value]
                      : picked.filter((v) => v !== o.value)
                  )
                }
              />
              {o.label}
            </Label>
          ))}
          {f.custom && (
            <Input
              className="h-8 w-56"
              aria-label={`${label}: other`}
              placeholder="Other (comma-separated)"
              value={props.custom}
              onChange={(e) => props.onCustom(e.target.value)}
            />
          )}
        </div>
      );
      break;
    }
    case "external": {
      const href = safeUrl(f.url);
      control = href ? (
        <Button asChild variant="outline" size="sm" className="self-start">
          <a href={href} target="_blank" rel="noreferrer">
            Open <ExternalLinkIcon />
          </a>
        </Button>
      ) : (
        <span className="text-muted-foreground">
          No usable link{f.url ? `: ${f.url}` : ""}
        </span>
      );
      break;
    }
    default: {
      const options = optionsOf(f);
      if (options.length === 0) {
        control = (
          <Input
            type={inputType(f.format)}
            className="h-8"
            aria-label={label}
            required={f.required}
            pattern={f.pattern}
            minLength={f.minLength}
            maxLength={f.maxLength}
            value={text}
            onChange={(e) => props.onChange(e.target.value)}
          />
        );
        break;
      }
      const isOption = options.some((o) => o.value === text);
      control = (
        <div className={CHOICES}>
          {options.length <= RADIO_LIMIT ? (
            <RadioGroup
              className="flex flex-wrap gap-x-4 gap-y-2"
              name={name}
              aria-label={label}
              value={isOption ? text : ""}
              onValueChange={props.onChange}
            >
              {options.map((o) => (
                <Label key={o.value} className="font-normal">
                  <RadioGroupItem value={o.value} /> {o.label}
                </Label>
              ))}
            </RadioGroup>
          ) : (
            <Choice
              label={label}
              value={isOption ? text : ""}
              onChange={props.onChange}
              options={[
                { label: "Choose…", value: "" },
                ...options.map((o) => ({ label: o.label, value: o.value })),
              ]}
            />
          )}
          {f.custom && (
            <Input
              className="h-8 w-56"
              aria-label={`${label}: other`}
              placeholder="Other…"
              value={isOption ? "" : text}
              onChange={(e) => props.onChange(e.target.value)}
            />
          )}
        </div>
      );
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-medium">
        {label}
        {f.required && <span className="text-attention"> *</span>}
      </span>
      {f.description && (
        <span className="text-muted-foreground text-xs">{f.description}</span>
      )}
      {control}
      {props.error && (
        <span className="text-destructive text-xs">{props.error}</span>
      )}
    </div>
  );
};

const CARD =
  "flex flex-col gap-2.5 rounded-lg border border-attention/35 bg-card px-3.5 py-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-attention focus-visible:ring-offset-1 focus-visible:ring-offset-background";
const ACTIONS = "flex flex-wrap items-center gap-2";
const CHOICES = "flex flex-wrap items-center gap-x-4 gap-y-2";
