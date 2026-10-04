import { type FormEvent, Fragment, type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from "react";
import type { FormField, PendingForm, PendingPermission, PermissionDecision, ProjectView, SessionSummary } from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import { dismissForm, type ReplyOutcome, replyForm, replyPermission } from "../api";
import { type CardAction, canTakeFocus, cardAction } from "../card-keys";
import {
  buildAnswer,
  type FieldValue,
  fieldLabel,
  type FormValues,
  formSupported,
  initialValues,
  inputType,
  isVisible,
  optionsOf,
  safeUrl,
} from "../forms";
import { ensurePatchHeader } from "../review";
import { PatchView } from "./LazyPatchView";
import { Icon } from "./Icon";

const RESOURCE_LIMIT = 5;
const RADIO_LIMIT = 5;

type Item = { kind: "permission"; item: PendingPermission } | { kind: "form"; item: PendingForm };

/**
 * The card's shortcut keys. Keys only count while the card itself has focus (never while typing in one of
 * its fields), and not while the card has just appeared. j/k move between cards and are handled here.
 */
function useCardKeys(onAction: (action: CardAction) => void) {
  const mountedAt = useRef(Date.now());
  return (e: KeyboardEvent<HTMLElement>) => {
    const action = cardAction(
      { key: e.key, repeat: e.repeat, onCard: e.target === e.currentTarget, modified: e.metaKey || e.ctrlKey || e.altKey },
      mountedAt.current,
      Date.now(),
    );
    if (!action) return;
    e.preventDefault();
    if (action === "next" || action === "prev") {
      const cards = [...document.querySelectorAll<HTMLElement>(".pending-card")];
      cards[cards.indexOf(e.currentTarget) + (action === "next" ? 1 : -1)]?.focus();
    } else onAction(action);
  };
}

/** Focuses the card when it mounts if the stack hands it focus, so answering by keyboard lands on the next card. */
function useAutoFocus(takeFocus: () => boolean) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (el && takeFocus()) el.focus();
    },
    [takeFocus],
  );
}

function useReply(onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = (send: () => Promise<ReplyOutcome>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    send().then(onDone, (err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    });
  };
  return { busy, error, run };
}

/** What one session waits on, oldest first. Only the oldest is shown; answering it reveals the next. */
export function PendingStack(props: { session: SessionSummary; view: ProjectView }) {
  const { session, view } = props;
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
  // One-shot: set when an item is answered while focus was in this stack; the next card claims it on mount.
  const focusClaim = useRef(false);
  const stack = useRef<HTMLDivElement>(null);
  const takeFocus = useCallback(() => {
    const claimed = focusClaim.current;
    focusClaim.current = false;
    return claimed && canTakeFocus<Element>(document.activeElement, document.body, stack.current);
  }, []);
  const items: Item[] = [
    ...(session.pending?.permissions ?? []).map((item) => ({ kind: "permission" as const, item })),
    ...(session.pending?.forms ?? []).map((item) => ({ kind: "form" as const, item })),
  ]
    .filter((i) => !answered.has(i.item.id))
    .sort((a, b) => (a.item.createdAt ?? 0) - (b.item.createdAt ?? 0));
  if (items.length === 0) return null;

  const current = items[0];
  const done = () => {
    focusClaim.current = stack.current?.contains(document.activeElement) ?? false;
    setAnswered((prev) => new Set(prev).add(current.item.id));
  };
  return (
    <div className="pending-stack" ref={stack}>
      {items.length > 1 && <p className="pending-count muted">1 of {items.length} waiting</p>}
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
          openUrl={sessionUrl(view.openUrl, session.id)}
          takeFocus={takeFocus}
          onDone={done}
        />
      )}
    </div>
  );
}

function PermissionCard(props: {
  projectId: string;
  sessionTitle: string;
  permission: PendingPermission;
  takeFocus: () => boolean;
  onDone: () => void;
}) {
  const { permission: p } = props;
  const { busy, error, run } = useReply(props.onDone);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const ref = useAutoFocus(props.takeFocus);
  const reply = (decision: PermissionDecision, message?: string) =>
    run(() => replyPermission(props.projectId, p.id, decision, message));

  const onKeyDown = useCardKeys((action) => {
    if (action === "reject") setRejecting(true);
    else reply(action === "always" ? "always" : "once");
  });

  const shown = p.resources.slice(0, RESOURCE_LIMIT);
  return (
    <section ref={ref} className="pending-card" tabIndex={0} onKeyDown={onKeyDown} aria-label={`${props.sessionTitle} wants ${p.action}`}>
      <p className="pending-ask">
        <span className="pending-who">{props.sessionTitle}</span> wants <strong>{p.action}</strong>
      </p>
      {shown.length > 0 && (
        <ul className="pending-resources">
          {shown.map((r, i) => (
            <li key={i}>
              <code>{r}</code>
            </li>
          ))}
          {p.resources.length > RESOURCE_LIMIT && <li className="muted">+{p.resources.length - RESOURCE_LIMIT} more</li>}
        </ul>
      )}
      {p.message && <p className="pending-message">{p.message}</p>}
      {p.diff && (
        <div className="pending-diff">
          <PatchView patch={ensurePatchHeader(p.diff, p.resources[0] ?? "change")} />
        </div>
      )}
      {rejecting ? (
        <form
          className="pending-actions"
          onSubmit={(e) => {
            e.preventDefault();
            reply("reject", reason.trim() || undefined);
          }}
        >
          <input
            autoFocus
            className="pending-reason"
            placeholder="Reason for the agent (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRejecting(false);
            }}
          />
          <button type="submit" disabled={busy}>
            Reject
          </button>
          <button type="button" className="link" onClick={() => setRejecting(false)}>
            Cancel
          </button>
        </form>
      ) : (
        <div className="pending-actions">
          <button className="button primary" disabled={busy} onClick={() => reply("once")}>
            Allow once <kbd>↵</kbd>
          </button>
          <button
            disabled={busy}
            title={p.save?.length ? `Saves a rule for: ${p.save.join(", ")}` : "Allow this and future requests like it"}
            onClick={() => reply("always")}
          >
            Always allow <kbd>a</kbd>
          </button>
          <button disabled={busy} onClick={() => setRejecting(true)}>
            Reject… <kbd>r</kbd>
          </button>
        </div>
      )}
      {error && (
        <p className="pending-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function FormCard(props: { projectId: string; form: PendingForm; openUrl: string; takeFocus: () => boolean; onDone: () => void }) {
  const { form } = props;
  const { busy, error, run } = useReply(props.onDone);
  const [values, setValues] = useState<FormValues>(() => initialValues(form.fields));
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const ref = useAutoFocus(props.takeFocus);
  // Forms only use j/k; Enter in a form field submits the form natively.
  const onKeyDown = useCardKeys(() => {});

  if (!formSupported(form.fields)) {
    return (
      <section ref={ref} className="pending-card" tabIndex={0} onKeyDown={onKeyDown} aria-label={form.title}>
        <p className="pending-ask">{form.title}</p>
        <dl className="pending-readonly">
          {form.fields.map((f) => (
            <Fragment key={f.key}>
              <dt>{fieldLabel(f)}</dt>
              <dd className="muted">{f.type}</dd>
            </Fragment>
          ))}
        </dl>
        <div className="pending-actions">
          <a className="button primary" href={props.openUrl} target="_blank" rel="noreferrer">
            Answer in opencode <Icon name="external" size={13} />
          </a>
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
    <form ref={ref} className="pending-card" tabIndex={0} onKeyDown={onKeyDown} onSubmit={submit} aria-label={form.title}>
      <p className="pending-ask">{form.title}</p>
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
      <div className="pending-actions">
        <button type="submit" className="button primary" disabled={busy}>
          Submit
        </button>
        <button type="button" disabled={busy} onClick={dismiss}>
          Dismiss
        </button>
      </div>
      {error && (
        <p className="pending-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function FieldControl(props: {
  name: string;
  field: FormField;
  value: FieldValue | undefined;
  custom: string;
  error?: string;
  onChange: (v: FieldValue) => void;
  onCustom: (text: string) => void;
}) {
  const { field: f, value, name } = props;
  const label = fieldLabel(f);
  const text = typeof value === "string" ? value : "";
  let control: ReactNode;
  switch (f.type) {
    case "boolean":
      control = (
        <label className="pending-choice">
          <input type="checkbox" checked={value === true} onChange={(e) => props.onChange(e.target.checked)} /> Yes
        </label>
      );
      break;
    case "number":
    case "integer":
      control = (
        <input
          type="number"
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
    case "multiselect": {
      const picked = Array.isArray(value) ? value : [];
      control = (
        <div className="pending-choices">
          {optionsOf(f).map((o) => (
            <label key={o.value} className="pending-choice">
              <input
                type="checkbox"
                checked={picked.includes(o.value)}
                onChange={(e) => props.onChange(e.target.checked ? [...picked, o.value] : picked.filter((v) => v !== o.value))}
              />{" "}
              {o.label}
            </label>
          ))}
          {f.custom && (
            <input aria-label={`${label}: other`} placeholder="Other (comma-separated)" value={props.custom} onChange={(e) => props.onCustom(e.target.value)} />
          )}
        </div>
      );
      break;
    }
    case "external": {
      const href = safeUrl(f.url);
      control = href ? (
        <a className="button" href={href} target="_blank" rel="noreferrer">
          Open <Icon name="external" size={13} />
        </a>
      ) : (
        <span className="muted">No usable link{f.url ? `: ${f.url}` : ""}</span>
      );
      break;
    }
    default: {
      const options = optionsOf(f);
      if (options.length === 0) {
        control = (
          <input
            type={inputType(f.format)}
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
        <div className="pending-choices">
          {options.length <= RADIO_LIMIT ? (
            options.map((o) => (
              <label key={o.value} className="pending-choice">
                <input type="radio" name={name} checked={text === o.value} onChange={() => props.onChange(o.value)} /> {o.label}
              </label>
            ))
          ) : (
            <select aria-label={label} value={isOption ? text : ""} onChange={(e) => props.onChange(e.target.value)}>
              <option value="">Choose…</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {f.custom && (
            <input aria-label={`${label}: other`} placeholder="Other…" value={isOption ? "" : text} onChange={(e) => props.onChange(e.target.value)} />
          )}
        </div>
      );
    }
  }
  return (
    <div className="pending-field">
      <span className="pending-label">
        {label}
        {f.required && <span className="tone-text-attention"> *</span>}
      </span>
      {f.description && <span className="muted pending-hint">{f.description}</span>}
      {control}
      {props.error && <span className="pending-error">{props.error}</span>}
    </div>
  );
}
