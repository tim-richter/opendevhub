import {
  DOTFILES_REPOSITORY,
  FEATURE_ID,
  mountError,
} from "../../../shared/personalization";
import type {
  FeatureOptions,
  PersonalMount,
  Personalization,
  ResolvedPersonalization,
} from "../../../shared/personalization";

/** One feature row being edited: its options as the JSON the user types. */
export interface FeatureDraft {
  /** Stable across edits, for React. */
  key: number;
  id: string;
  options: string;
}

/** One mount row being edited. */
export interface MountDraft extends PersonalMount {
  /** Stable across edits, for React. */
  key: number;
}

export interface PersonalizationDraft {
  features: FeatureDraft[];
  mounts: MountDraft[];
  setupCommand: string;
  repository: string;
  installCommand: string;
  targetPath: string;
}

let nextKey = 0;
export const featureDraft = (
  id = "",
  options: FeatureOptions = {}
): FeatureDraft => {
  nextKey += 1;
  return {
    id,
    key: nextKey,
    options: Object.keys(options).length > 0 ? JSON.stringify(options) : "",
  };
};

export const mountDraft = (
  m: PersonalMount = { source: "", target: "", type: "bind" }
): MountDraft => {
  nextKey += 1;
  return { ...m, key: nextKey };
};

/** Why the mount can't be used, or undefined when it can; nothing while a field is still empty. */
export const mountDraftError = (m: MountDraft): string | undefined =>
  m.source.trim() && m.target.trim()
    ? mountError({ ...m, source: m.source.trim(), target: m.target.trim() })
    : undefined;

export const personalizationDraft = (
  p: Personalization
): PersonalizationDraft => ({
  features: Object.entries(p.features).map(([id, options]) =>
    featureDraft(id, options)
  ),
  installCommand: p.dotfiles?.installCommand ?? "",
  mounts: (p.mounts ?? []).map((m) => mountDraft(m)),
  repository: p.dotfiles?.repository ?? "",
  setupCommand: p.setupCommand ?? "",
  targetPath: p.dotfiles?.targetPath ?? "",
});

/** Why the feature's options aren't a JSON object, or undefined when they are (or are empty). */
export const optionsError = (text: string): string | undefined => {
  if (!text.trim()) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? undefined
      : 'Options must be a JSON object, like {"version": "latest"}';
  } catch {
    return "Options are not valid JSON";
  }
};

/** Why the feature id can't be used, or undefined when it can. */
export const featureIdError = (id: string): string | undefined => {
  const trimmed = id.trim();
  if (!trimmed) {
    return "Enter a feature id";
  }
  return FEATURE_ID.test(trimmed)
    ? undefined
    : "Use a published feature, like ghcr.io/owner/repo/feature:1 — local ./ features aren't supported";
};

/** What the API takes, or the first problem with the draft. */
export const personalizationOf = (
  d: PersonalizationDraft
): { value: Personalization } | { error: string } => {
  const features: Record<string, FeatureOptions> = {};
  for (const f of d.features) {
    if (!(f.id.trim() || f.options.trim())) {
      continue;
    }
    const problem = featureIdError(f.id) ?? optionsError(f.options);
    if (problem) {
      return { error: `${f.id.trim() || "Feature"}: ${problem}` };
    }
    const id = f.id.trim();
    if (id in features) {
      return { error: `${id} is listed twice` };
    }
    features[id] = f.options.trim()
      ? (JSON.parse(f.options) as FeatureOptions)
      : {};
  }
  const mounts: PersonalMount[] = [];
  for (const m of d.mounts) {
    const source = m.source.trim();
    const target = m.target.trim();
    if (!(source || target)) {
      continue;
    }
    if (!(source && target)) {
      return {
        error: `Mount ${source || target}: enter both where it comes from and where it goes`,
      };
    }
    const mount = { source, target, type: m.type };
    const problem = mountError(mount);
    if (problem) {
      return { error: `Mount ${target}: ${problem}` };
    }
    if (mounts.some((o) => o.target === target)) {
      return { error: `Two mounts go to ${target}` };
    }
    mounts.push(mount);
  }
  const repository = d.repository.trim();
  if (repository && !DOTFILES_REPOSITORY.test(repository)) {
    return {
      error:
        "Dotfiles repository: use owner/repo or a git URL (https://, ssh:// or git@host:path)",
    };
  }
  return {
    value: {
      features,
      ...(mounts.length > 0 ? { mounts } : {}),
      ...(d.setupCommand.trim() ? { setupCommand: d.setupCommand } : {}),
      ...(repository
        ? {
            dotfiles: {
              repository,
              ...(d.installCommand.trim()
                ? { installCommand: d.installCommand.trim() }
                : {}),
              ...(d.targetPath.trim()
                ? { targetPath: d.targetPath.trim() }
                : {}),
            },
          }
        : {}),
    },
  };
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "2 features, a setup command and dotfiles", or "nothing". */
export const summary = (
  p: Personalization | ResolvedPersonalization
): string => {
  const parts: string[] = [];
  const features = Object.keys(p.features).length;
  if (features > 0) {
    parts.push(plural(features, "feature"));
  }
  const commands =
    "setupCommands" in p
      ? p.setupCommands.length
      : Number(Boolean(p.setupCommand));
  if (commands === 1) {
    parts.push("a setup command");
  } else if (commands > 1) {
    parts.push(plural(commands, "setup command"));
  }
  const mounts = p.mounts?.length ?? 0;
  if (mounts > 0) {
    parts.push(plural(mounts, "mount"));
  }
  if (p.dotfiles) {
    parts.push(`dotfiles from ${p.dotfiles.repository}`);
  }
  if (parts.length === 0) {
    return "nothing";
  }
  return parts.length === 1
    ? parts[0]
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
};
