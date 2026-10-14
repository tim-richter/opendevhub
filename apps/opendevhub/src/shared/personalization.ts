/** Options of one devcontainer Feature, as in devcontainer.json's `features`. */
export type FeatureOptions = Record<string, unknown>;

/** A dotfiles repository the devcontainer CLI clones into each container and runs the install script of. */
export interface Dotfiles {
  /** A git URL, or `owner/repo` on GitHub. */
  repository: string;
  /** Defaults to the first of install.sh, install, bootstrap.sh, bootstrap, setup.sh, setup in the repository. */
  installCommand?: string;
  /** Defaults to `~/dotfiles`. */
  targetPath?: string;
}

/**
 * What the user adds to every container on top of the repository's devcontainer.json, kept in opendevhub's
 * config.json and never in the repository.
 */
export interface Personalization {
  /** Feature id → options, as in devcontainer.json's `features`. Published features only (OCI or https). */
  features: Record<string, FeatureOptions>;
  /** A shell script run in the container once it is created, and again whenever it changes. */
  setupCommand?: string;
  dotfiles?: Dotfiles;
}

/** A project's personalization: added to the global one unless `inheritGlobal` is off. */
export interface ProjectPersonalization extends Personalization {
  inheritGlobal: boolean;
}

/** What a project's containers get: the global and project settings merged. */
export interface ResolvedPersonalization {
  features: Record<string, FeatureOptions>;
  /** Run in order, each on its own. */
  setupCommands: string[];
  dotfiles?: Dotfiles;
}

export interface PersonalizationView {
  personalization: Personalization;
}

export interface ProjectPersonalizationView {
  personalization: ProjectPersonalization;
  /** The global settings, for showing what the project inherits. */
  global: Personalization;
  effective: ResolvedPersonalization;
  /** The project's container was created with other features or dotfiles: a rebuild applies the current ones. */
  rebuildNeeded: boolean;
}

export const FEATURE_ID_MAX = 300;
export const SETUP_COMMAND_MAX = 20_000;
export const FEATURES_MAX = 50;
/**
 * A published feature: an OCI reference (`ghcr.io/owner/repo/feature:1`) or an https tarball. Local
 * `./feature` folders aren't supported: they'd have to exist in the repository.
 */
export const FEATURE_ID =
  /^(?:https:\/\/\S+|[a-z0-9][\w.-]*(?::\d+)?\/[\w./-]+(?::[\w.-]+|@sha256:[a-f0-9]{64})?)$/iu;
/** A git URL or `owner/repo`; never starting with `-`, which git would read as an option. */
export const DOTFILES_REPOSITORY =
  /^(?:[\w.-]+\/[\w.-]+|(?:https?|ssh|git):\/\/\S+|[\w.-]+@[\w.-]+:\S+)$/u;

export const EMPTY_PERSONALIZATION: Personalization = { features: {} };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const readFeatures = (value: unknown): Record<string, FeatureOptions> => {
  const out: Record<string, FeatureOptions> = {};
  for (const [id, options] of Object.entries(record(value) ?? {})) {
    const key = id.trim();
    const opts = options === true ? {} : record(options);
    if (key.length <= FEATURE_ID_MAX && FEATURE_ID.test(key) && opts) {
      out[key] = opts;
    }
  }
  return out;
};

const readDotfiles = (value: unknown): Dotfiles | undefined => {
  const d = record(value);
  const repository = text(d?.repository);
  if (!(d && repository && DOTFILES_REPOSITORY.test(repository))) {
    return undefined;
  }
  const installCommand = text(d.installCommand);
  const targetPath = text(d.targetPath);
  return {
    repository,
    ...(installCommand ? { installCommand } : {}),
    ...(targetPath ? { targetPath } : {}),
  };
};

/** The global personalization from config.json, dropping what isn't valid. */
export const readPersonalization = (value: unknown): Personalization => {
  const p = record(value) ?? {};
  const setupCommand =
    typeof p.setupCommand === "string" && p.setupCommand.trim()
      ? p.setupCommand
      : undefined;
  const dotfiles = readDotfiles(p.dotfiles);
  return {
    features: readFeatures(p.features),
    ...(setupCommand ? { setupCommand } : {}),
    ...(dotfiles ? { dotfiles } : {}),
  };
};

/** A project's personalization from its config.json entry; it inherits the global one by default. */
export const readProjectPersonalization = (
  value: unknown
): ProjectPersonalization => ({
  ...readPersonalization(value),
  inheritGlobal: record(value)?.inheritGlobal !== false,
});

/**
 * The project's settings on top of the global ones: the project's options win for a feature both list,
 * both setup commands run (the global one first), and the project's dotfiles replace the global ones.
 */
export const resolvePersonalization = (
  global: Personalization,
  project: ProjectPersonalization
): ResolvedPersonalization => {
  const base = project.inheritGlobal ? global : EMPTY_PERSONALIZATION;
  const dotfiles = project.dotfiles ?? base.dotfiles;
  return {
    features: { ...base.features, ...project.features },
    setupCommands: [base.setupCommand, project.setupCommand].filter(
      (c): c is string => c !== undefined
    ),
    ...(dotfiles ? { dotfiles } : {}),
  };
};

/** Whether the merged personalization adds anything at all. */
export const isEmptyPersonalization = (p: ResolvedPersonalization): boolean =>
  Object.keys(p.features).length === 0 &&
  p.setupCommands.length === 0 &&
  !p.dotfiles;

/** JSON with object keys sorted, so the same settings in another order serialize the same. */
export const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).toSorted(([a], [b]) =>
            a < b ? -1 : Number(a > b)
          )
        )
      : v
  );

/** What a container has to be created with: its features and dotfiles. Setup commands run on every start. */
export const creationSettings = (p: ResolvedPersonalization): string =>
  stableJson({ dotfiles: p.dotfiles ?? null, features: p.features });
