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
 * A folder of this machine (or of the node the container runs on), or a Docker volume, mounted into the container.
 * Read and write: the dev container CLI's `--mount` takes no other options.
 */
export interface PersonalMount {
  type: "bind" | "volume";
  /** An absolute path or one under `~` for a bind mount; a volume's name. */
  source: string;
  /** An absolute path in the container. */
  target: string;
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
  mounts?: PersonalMount[];
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
  /** Absent when there are none. */
  mounts?: PersonalMount[];
}

export interface PersonalizationView {
  personalization: Personalization;
}

export interface ProjectPersonalizationView {
  personalization: ProjectPersonalization;
  /** The global settings, for showing what the project inherits. */
  global: Personalization;
  effective: ResolvedPersonalization;
  /** The project's container was created with other features, dotfiles or mounts: a rebuild applies the current ones. */
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

export const MOUNTS_MAX = 20;
/** Where opendevhub mounts its own state in every container. */
export const RESERVED_MOUNT_ROOT = "/opendevhub";
const MOUNT_PATH = /^\/[^,\s]*$/u;
const BIND_SOURCE = /^(?:~|~\/[^,]*|\/[^,]*)$/u;
const VOLUME_NAME = /^[A-Za-z0-9][\w.-]*$/u;

/** Why a mount can't be passed to `--mount`, or undefined when it can. */
export const mountError = (m: PersonalMount): string | undefined => {
  if (
    m.type === "bind"
      ? !BIND_SOURCE.test(m.source)
      : !VOLUME_NAME.test(m.source)
  ) {
    return m.type === "bind"
      ? "Use an absolute path or one under ~, without commas"
      : "Use a volume name: letters, digits, '.', '_' and '-'";
  }
  if (!MOUNT_PATH.test(m.target) || m.target.split("/").includes("..")) {
    return "The target must be an absolute path in the container, without commas or ..";
  }
  if (
    m.target === RESERVED_MOUNT_ROOT ||
    m.target.startsWith(`${RESERVED_MOUNT_ROOT}/`)
  ) {
    return `${RESERVED_MOUNT_ROOT} is where opendevhub keeps its own state`;
  }
  return undefined;
};

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

/** Valid mounts, the last one winning when two share a target. */
const readMounts = (value: unknown): PersonalMount[] => {
  const byTarget = new Map<string, PersonalMount>();
  for (const raw of Array.isArray(value) ? value : []) {
    const m = record(raw);
    const source = text(m?.source);
    const target = text(m?.target)?.replace(/(?<=.)\/+$/u, "");
    if (!(source && target)) {
      continue;
    }
    const mount: PersonalMount = {
      source,
      target,
      type: m?.type === "volume" ? "volume" : "bind",
    };
    if (!mountError(mount)) {
      byTarget.delete(target);
      byTarget.set(target, mount);
    }
  }
  return [...byTarget.values()].slice(0, MOUNTS_MAX);
};

/** The global personalization from config.json, dropping what isn't valid. */
export const readPersonalization = (value: unknown): Personalization => {
  const p = record(value) ?? {};
  const setupCommand =
    typeof p.setupCommand === "string" && p.setupCommand.trim()
      ? p.setupCommand
      : undefined;
  const dotfiles = readDotfiles(p.dotfiles);
  const mounts = readMounts(p.mounts);
  return {
    features: readFeatures(p.features),
    ...(setupCommand ? { setupCommand } : {}),
    ...(dotfiles ? { dotfiles } : {}),
    ...(mounts.length > 0 ? { mounts } : {}),
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
 * both setup commands run (the global one first), the project's dotfiles replace the global ones, and the
 * project's mount wins for a target both use.
 */
export const resolvePersonalization = (
  global: Personalization,
  project: ProjectPersonalization
): ResolvedPersonalization => {
  const base = project.inheritGlobal ? global : EMPTY_PERSONALIZATION;
  const dotfiles = project.dotfiles ?? base.dotfiles;
  const own = project.mounts ?? [];
  const mounts = [
    ...(base.mounts ?? []).filter(
      (m) => !own.some((o) => o.target === m.target)
    ),
    ...own,
  ];
  return {
    features: { ...base.features, ...project.features },
    setupCommands: [base.setupCommand, project.setupCommand].filter(
      (c): c is string => c !== undefined
    ),
    ...(dotfiles ? { dotfiles } : {}),
    ...(mounts.length > 0 ? { mounts } : {}),
  };
};

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

/**
 * What a container has to be created with: its features, dotfiles and mounts. Setup commands run on every start.
 * Without mounts it reads as before mounts existed, so containers created then don't look out of date.
 */
export const creationSettings = (p: ResolvedPersonalization): string =>
  stableJson({
    dotfiles: p.dotfiles ?? null,
    features: p.features,
    ...(p.mounts?.length ? { mounts: p.mounts } : {}),
  });

/** Where a mount comes from, with `~` read as `home`. */
export const mountSource = (m: PersonalMount, home: string): string =>
  m.type === "bind" && (m.source === "~" || m.source.startsWith("~/"))
    ? `${home.replace(/\/+$/u, "")}${m.source.slice(1)}`
    : m.source;

/** The `--mount` value for a mount, with `~` read as `home`. */
export const mountArg = (m: PersonalMount, home: string): string =>
  `type=${m.type},source=${mountSource(m, home)},target=${m.target}`;
