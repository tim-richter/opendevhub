import type { FormAnswer, FormField } from "../../../shared/types";

export type FieldValue = string | boolean | string[];
export type FormValues = Record<string, FieldValue>;
export interface FieldOption {
  value: string;
  label: string;
}

const SUPPORTED = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "multiselect",
  "external",
]);

/** False when a field type is new to us; the UI then links to opencode instead of guessing. */
export const formSupported = (fields: FormField[]): boolean =>
  fields.every((f) => SUPPORTED.has(f.type));

export const fieldLabel = (field: FormField): string =>
  field.title?.trim() || field.key;

export const optionsOf = (field: FormField): FieldOption[] =>
  (field.options ?? []).map((o) =>
    typeof o === "string"
      ? { label: o, value: o }
      : { label: o.label ?? String(o.value), value: String(o.value) }
  );

export const initialValues = (fields: FormField[]): FormValues => {
  const values: FormValues = {};
  for (const f of fields) {
    if (f.type === "external") {
      continue;
    }
    if (f.type === "boolean") {
      values[f.key] = f.default === true;
    } else if (f.type === "multiselect") {
      values[f.key] = Array.isArray(f.default) ? f.default.map(String) : [];
    } else {
      values[f.key] =
        f.default === undefined || f.default === null ? "" : String(f.default);
    }
  }
  return values;
};

const equals = (actual: FieldValue | undefined, expected: unknown): boolean => {
  if (actual === undefined) {
    return false;
  }
  if (Array.isArray(actual)) {
    return actual.includes(String(expected));
  }
  return String(actual) === String(expected);
};

/** `hidden` and `when` decide visibility; inputs hold strings, so typed conditions compare by value. */
export const isVisible = (field: FormField, values: FormValues): boolean => {
  if (field.hidden) {
    return false;
  }
  return (field.when ?? []).every((c) =>
    c.op === "neq"
      ? !equals(values[c.key], c.value)
      : equals(values[c.key], c.value)
  );
};

const matchesPattern = (value: string, pattern: string): boolean => {
  try {
    return new RegExp(`^(?:${pattern})$`, "u").test(value);
  } catch {
    return true; // an invalid pattern from the agent must not block the answer
  }
};

const isAnswerValue = (v: unknown): v is FormAnswer[string] =>
  typeof v === "string" ||
  typeof v === "number" ||
  typeof v === "boolean" ||
  (Array.isArray(v) && v.every((x) => typeof x === "string"));

export type BuildResult =
  | { ok: true; answer: FormAnswer }
  | { ok: false; errors: Record<string, string> };

/** Turns the form's values into opencode's answer, or per-field errors. Fields hidden by `when` are left out. */
export const buildAnswer = (
  fields: FormField[],
  values: FormValues,
  custom: Record<string, string> = {}
): BuildResult => {
  const answer: FormAnswer = {};
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (f.type === "external") {
      continue;
    }
    if (f.hidden) {
      if (isAnswerValue(f.default)) {
        answer[f.key] = f.default;
      }
      continue;
    }
    if (!isVisible(f, values)) {
      continue;
    }
    const v = values[f.key];
    switch (f.type) {
      case "boolean": {
        answer[f.key] = v === true;
        break;
      }
      case "number":
      case "integer": {
        const text = typeof v === "string" ? v.trim() : "";
        if (!text) {
          if (f.required) {
            errors[f.key] = "Required";
          }
          break;
        }
        const n = Number(text);
        if (
          !Number.isFinite(n) ||
          (f.type === "integer" && !Number.isInteger(n))
        ) {
          errors[f.key] =
            f.type === "integer" ? "Enter a whole number" : "Enter a number";
        } else if (f.minimum !== undefined && n < f.minimum) {
          errors[f.key] = `At least ${f.minimum}`;
        } else if (f.maximum !== undefined && n > f.maximum) {
          errors[f.key] = `At most ${f.maximum}`;
        } else {
          answer[f.key] = n;
        }
        break;
      }
      case "multiselect": {
        const extra = f.custom
          ? (custom[f.key] ?? "")
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];
        const items = [...new Set([...(Array.isArray(v) ? v : []), ...extra])];
        if (f.required && items.length === 0) {
          errors[f.key] = "Pick at least one";
        } else if (f.minItems !== undefined && items.length < f.minItems) {
          errors[f.key] = `Pick at least ${f.minItems}`;
        } else if (f.maxItems !== undefined && items.length > f.maxItems) {
          errors[f.key] = `Pick at most ${f.maxItems}`;
        } else {
          answer[f.key] = items;
        }
        break;
      }
      default: {
        const text = typeof v === "string" ? v : "";
        if (!text.trim()) {
          if (f.required) {
            errors[f.key] = "Required";
          }
          break;
        }
        if (f.minLength !== undefined && text.length < f.minLength) {
          errors[f.key] = `At least ${f.minLength} characters`;
        } else if (f.maxLength !== undefined && text.length > f.maxLength) {
          errors[f.key] = `At most ${f.maxLength} characters`;
        } else if (f.pattern && !matchesPattern(text, f.pattern)) {
          errors[f.key] = "Doesn't match the expected format";
        } else {
          answer[f.key] = text;
        }
      }
    }
  }
  return Object.keys(errors).length > 0
    ? { errors, ok: false }
    : { answer, ok: true };
};

/** Agent-supplied links are only followed when they are plain http(s). */
export const safeUrl = (url: string | undefined): string | undefined => {
  if (!url) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
};

export const inputType = (
  format: string | undefined
): "text" | "email" | "url" | "date" => {
  if (format === "email") {
    return "email";
  }
  if (format === "uri" || format === "url") {
    return "url";
  }
  if (format === "date") {
    return "date";
  }
  return "text";
};
