import type { ModelRef, TaskVariantSpec } from "./types";

export const TITLE_MAX = 60;
export const MAX_VARIANTS = 4;
const SLUG_MAX = 40;
const SHORT_MAX = 30;

/** The first non-empty line of the prompt, without leading markdown markers, at most 60 characters. */
export function deriveTitle(prompt: string): string {
  const line =
    prompt
      .split("\n")
      .map((l) => l.replace(/^[\s#>*-]+/, "").replace(/\s+/g, " ").trim())
      .find(Boolean) ?? "";
  if (line.length <= TITLE_MAX) return line;
  const cut = line.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Lowercase ASCII words joined by "-", at most `max` characters; "" when nothing is left. */
export function slugify(text: string, max = SLUG_MAX): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}

export function branchSlug(title: string): string {
  return slugify(title) || "task";
}

/** `anthropic/claude-opus-5-5` with variant `high` → `claude-opus-5-5-high`. */
export function modelShortName(ref: ModelRef): string {
  const name = ref.id.split("/").filter(Boolean).at(-1) ?? ref.id;
  const variant = ref.variant && ref.variant !== "default" ? `-${ref.variant}` : "";
  return slugify(name + variant, SHORT_MAX) || "model";
}

/** Model short names when every variant names a distinct model; otherwise "1", "2"… */
export function variantLabels(variants: TaskVariantSpec[]): string[] {
  const names = variants.map((v) => (v.model ? modelShortName(v.model) : undefined));
  const usable = names.every((n) => n !== undefined) && new Set(names).size === names.length;
  return usable ? (names as string[]) : variants.map((_, i) => String(i + 1));
}

export function variantTitle(title: string, label: string, of: number): string {
  if (of === 1) return title;
  return `${title} · ${/^\d+$/.test(label) ? `#${label}` : label}`;
}

/** `name`, or `name-2`, `name-3`… whichever is free; the result is added to `taken`. */
export function uniqueBranch(name: string, taken: Set<string>): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n++) candidate = `${name}-${n}`;
  taken.add(candidate);
  return candidate;
}

/**
 * The branch of each variant. A branch typed for a single variant is used as is (an existing one is checked
 * out); every generated name is made free against `taken`, which is not modified.
 */
export function taskBranches(o: { branch?: string; title: string; variants: TaskVariantSpec[]; taken?: Set<string> }): string[] {
  const taken = new Set(o.taken ?? []);
  const typed = o.branch?.trim();
  const base = typed || branchSlug(o.title);
  if (o.variants.length === 1) return [typed ? typed : uniqueBranch(base, taken)];
  return variantLabels(o.variants).map((label) => uniqueBranch(`${base}-${label}`, taken));
}
