import { type FormEvent, Fragment, type KeyboardEvent, type ReactNode, useCallback, useRef, useState } from "react";
import type { FormField, PendingForm, PendingPermission, PermissionDecision, ProjectView, SessionSummary } from "../../shared/types";
import { sessionUrl } from "../../shared/urls";
import { dismissForm, type ReplyOutcome, replyForm, replyPermission } from "../api";
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
import { Icon } from "./Icon";

const RESOURCE_LIMIT = 5;
const RADIO_LIMIT = 5;

type Item = { kind: "permission"; item: PendingPermission } | { kind: "form"; item: PendingForm };

/** Keys belong to the card only while the card itself has focus, never while typing in one of its fields. */
function ownKey(e: KeyboardEvent<HTMLElement>): boolean {
  return e.target === e.currentTarget && !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** j/k move between cards on the page. */
function moveBetweenCards(e: KeyboardEvent<HTMLElement>): void {
  if (e.key !== "j" && e.key !== "k") return;
  e.preventDefault();
  const cards = [...document.querySelectorAll<HTMLElement>(".pending-card")];
  cards[cards.indexOf(e.currentTarget) + (e.key === "j" ? 1 : -1)]?.focus();
}

/** Focuses the card when it mounts, so answering one card by keyboard lands on the next. */
function useAutoFocus(enabled: boolean) {
  return useCallback(
    (el: HTMLElement | null) => {
      if (enabled && el) el.focus();
    },
    [enabled],
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
  const [focusNext, setFocusNext] = useState(false);
  const stack = useRef<HTMLDivElement>(null);
  const items: Item[] = [
    ...(session.pending?.permissions ?? []).map((item) => ({ kind: "permission" as const, item })),
    ...(session.pending?.forms ?? []).map((item) => ({ kind: "form" as const, item })),
  ]
    .filter((i) => !answered.has(i.item.id))
    .sort((a, b) => (a.item.createdAt ?? 0) - (b.item.createdAt ?? 0));
  if (items.length === 0) return null;

  const current = items[0];
  const done = () => {
    setFocusNext(stack.current?.contains(document.activeElement) ?? false);
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
          autoFocus={focusNext}
          onDone={done}
        />
      ) : (
        <FormCard
          key={current.item.id}
          projectId={view.project.id}
          form={current.item}
          openUrl={sessionUrl(view.openUrl, session.id)}
          autoFocus={focusNext}
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
  autoFocus: boolean;
  onDone: () => void;
}) {
  const { permission: p } = props;
  const { busy, error, run } = useReply(props.onDone);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const ref = useAutoFocus(props.autoFocus);
  const reply = (decision: PermissionDecision, message?: string) =>
    run(() => replyPermission(props.projectId, p.id, decision, message));

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!ownKey(e)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      reply("once");
    } else if (e.key === "a") {
      e.preventDefault();
      reply("always");
    } else if (e.key === "r") {
      e.preventDefault();
      setRejecting(true);
    } else moveBetweenCards(e);
  };

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
      {p.diff && <DiffView patch={p.diff} />}
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

function DiffView({ patch }: { patch: string }) {
  const kind = (line: string) =>
    line.startsWith("+++") || line.startsWith("---")
      ? "file"
      : line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "del"
          : line.startsWith("@@")
            ? "hunk"
            : undefined;
  return (
    <pre className="pending-diff">
      {patch.split("\n").map((line, i) => (
        <span key={i} className={kind(line)}>
          {line}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

function FormCard(props: { projectId: string; form: PendingForm; openUrl: string; autoFocus: boolean; onDone: () => void }) {
  const { form } = props;
  const { busy, error, run } = useReply(props.onDone);
  const [values, setValues] = useState<FormValues>(() => initialValues(form.fields));
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dismissing, setDismissing] = useState(false);
  const [reason, setReason] = useState("");
  const ref = useAutoFocus(props.autoFocus);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (ownKey(e)) moveBetweenCards(e);
  };

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
  const dismiss = () => run(() => dismissForm(props.projectId, form.id, reason.trim() || undefined));

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
      {dismissing ? (
        <div className="pending-actions">
          <input
            autoFocus
            className="pending-reason"
            placeholder="Why (optional, sent to the agent)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                dismiss();
              } else if (e.key === "Escape") setDismissing(false);
            }}
          />
          <button type="button" disabled={busy} onClick={dismiss}>
            Dismiss
          </button>
          <button type="button" className="link" onClick={() => setDismissing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="pending-actions">
          <button type="submit" className="button primary" disabled={busy}>
            Submit
          </button>
          <button type="button" disabled={busy} onClick={() => setDismissing(true)}>
            Dismiss…
          </button>
        </div>
      )}
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
