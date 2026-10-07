import type { ModelRef, TaskVariantSpec } from "./types";

export const TITLE_MAX = 60;
export const MAX_VARIANTS = 4;
const SLUG_MAX = 40;
const SHORT_MAX = 30;

/** The first non-empty line of the prompt, without leading markdown markers, at most 60 characters. */
export const deriveTitle = (prompt: string): string => {
  const line =
    prompt
      .split("\n")
      .map((l) =>
        l
          .replace(/^[\s#>*-]+/u, "")
          .replaceAll(/\s+/gu, " ")
          .trim()
      )
      .find(Boolean) ?? "";
  if (line.length <= TITLE_MAX) {
    return line;
  }
  const cut = line.slice(0, TITLE_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= TITLE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/** Lowercase ASCII words joined by "-", at most `max` characters; "" when nothing is left. */
export const slugify = (text: string, max = SLUG_MAX): string =>
  text
    .normalize("NFKD")
    .replaceAll(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, max)
    .replaceAll(/-+$/gu, "");

export const branchSlug = (title: string): string => slugify(title) || "task";

/** `anthropic/claude-opus-5-5` with variant `high` → `claude-opus-5-5-high`. */
export const modelShortName = (ref: ModelRef): string => {
  const name = ref.id.split("/").findLast(Boolean) ?? ref.id;
  const variant =
    ref.variant && ref.variant !== "default" ? `-${ref.variant}` : "";
  return slugify(name + variant, SHORT_MAX) || "model";
};

/** Model short names when every variant names a distinct model; otherwise "1", "2"… */
export const variantLabels = (variants: TaskVariantSpec[]): string[] => {
  const names = variants.map((v) =>
    v.model ? modelShortName(v.model) : undefined
  );
  const usable =
    names.every((n) => n !== undefined) && new Set(names).size === names.length;
  return usable ? (names as string[]) : variants.map((_, i) => String(i + 1));
};

export const variantTitle = (
  title: string,
  label: string,
  of: number
): string => {
  if (of === 1) {
    return title;
  }
  return `${title} · ${/^\d+$/u.test(label) ? `#${label}` : label}`;
};

/** `name`, or `name-2`, `name-3`… whichever is free; the result is added to `taken`. */
export const uniqueBranch = (name: string, taken: Set<string>): string => {
  let candidate = name;
  for (let n = 2; taken.has(candidate); n += 1) {
    candidate = `${name}-${n}`;
  }
  taken.add(candidate);
  return candidate;
};

/**
 * The branch of each variant. A branch typed for a single variant is used as is (an existing one is checked
 * out); every generated name is made free against `taken`, which is not modified.
 */
export const taskBranches = (o: {
  branch?: string;
  title: string;
  variants: TaskVariantSpec[];
  taken?: Set<string>;
}): string[] => {
  const taken = new Set(o.taken);
  const typed = o.branch?.trim();
  const base = typed || branchSlug(o.title);
  if (o.variants.length === 1) {
    return [typed || uniqueBranch(base, taken)];
  }
  return variantLabels(o.variants).map((label) =>
    uniqueBranch(`${base}-${label}`, taken)
  );
};
