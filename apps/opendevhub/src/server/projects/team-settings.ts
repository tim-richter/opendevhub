import fs from "node:fs";

import {
  applyEdits,
  format,
  modify,
  parse,
  printParseErrorCode,
} from "jsonc-parser";
import type { FormattingOptions, ParseError } from "jsonc-parser";

import type { Project } from "../../shared/types";
import { InvalidRequestError } from "../git/worktrees";

/** Settings a team can share in devcontainer.json `customizations.opendevhub`; anything else there is ignored. */
export const TEAM_KEYS = [
  "name",
  "shortName",
  "color",
  "jiraBoard",
  "jiraJql",
  "forgejoRepository",
  "isolation",
  "keyFiles",
  "checks",
] as const;

export type TeamKey = (typeof TEAM_KEYS)[number];

export interface TeamRead {
  /** `customizations.opendevhub`, limited to `TEAM_KEYS`. */
  settings: Partial<Record<TeamKey, unknown>>;
  /** devcontainer.json's own `forwardPorts`, unvalidated. */
  forwardPorts: unknown;
  /** Why the file couldn't be read; the team layer is empty then and can't be written. */
  errors: string[];
}

export interface TeamSettingsStore {
  get: (project: Project) => TeamRead;
  /** Replaces the given keys of `customizations.opendevhub`; an undefined value removes the key. */
  update: (project: Project, patch: Partial<Record<TeamKey, unknown>>) => void;
  /** Replaces devcontainer.json's `forwardPorts`; an empty list removes it. */
  setForwardPorts: (project: Project, ports: unknown[]) => void;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isTeamKey = (key: string): key is TeamKey =>
  (TEAM_KEYS as readonly string[]).includes(key);

/** devcontainer.json allows comments and trailing commas. */
export const parseDevcontainer = (
  text: string
): { value: Record<string, unknown> | undefined; errors: string[] } => {
  const problems: ParseError[] = [];
  const value: unknown = parse(text, problems, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (problems.length > 0) {
    return {
      value: undefined,
      errors: problems.map(
        (p) => `${printParseErrorCode(p.error)} at offset ${p.offset}`
      ),
    };
  }
  const object = record(value);
  return object
    ? { value: object, errors: [] }
    : { value: undefined, errors: ["expected a JSON object"] };
};

/** The team layer of a parsed devcontainer.json. */
export const readTeam = (
  json: Record<string, unknown> | undefined
): Omit<TeamRead, "errors"> => {
  const custom = record(record(json?.customizations)?.opendevhub) ?? {};
  const settings: TeamRead["settings"] = {};
  for (const [key, value] of Object.entries(custom)) {
    if (isTeamKey(key)) {
      settings[key] = value;
    }
  }
  return { settings, forwardPorts: json?.forwardPorts };
};

const INDENT = /^(?<indent>[ \t]+)\S/mu;

/** Edits keep the file's own indentation. */
const formattingOf = (text: string): FormattingOptions => {
  const indent = INDENT.exec(text)?.groups?.indent;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (indent?.startsWith("\t")) {
    return { eol, insertSpaces: false, tabSize: 1 };
  }
  return { eol, insertSpaces: true, tabSize: indent?.length ?? 2 };
};

type JsonPath = (string | number)[];

const CUSTOM_PATH: JsonPath = ["customizations", "opendevhub"];

/** Applies `[path, value]` edits to devcontainer.json text, keeping its comments and formatting. */
export const editDevcontainer = (
  text: string,
  edits: [JsonPath, unknown][]
): string => {
  const { value: before, errors } = parseDevcontainer(text);
  if (!before) {
    throw new InvalidRequestError(
      `devcontainer.json can't be edited: ${errors.join("; ")}`
    );
  }
  const formattingOptions = formattingOf(text);
  let out = text;
  for (const [path, value] of edits) {
    // modify's own formatting reaches into the neighbouring property; format only the inserted text instead.
    const changes = modify(out, path, value, {});
    out = applyEdits(out, changes);
    if (value !== undefined) {
      for (const { offset, content } of changes.toReversed()) {
        out = applyEdits(
          out,
          format(out, { offset, length: content.length }, formattingOptions)
        );
      }
    }
  }
  // Drop what the edits left empty, so removing the last setting leaves the file as it was.
  const after = parseDevcontainer(out).value;
  const customizations = record(after?.customizations);
  const opendevhub = record(customizations?.opendevhub);
  if (opendevhub && Object.keys(opendevhub).length === 0) {
    const onlyOurs = Object.keys(customizations ?? {}).length === 1;
    out = applyEdits(
      out,
      modify(out, onlyOurs ? ["customizations"] : CUSTOM_PATH, undefined, {})
    );
  }
  return out;
};

const writeAtomic = (file: string, text: string): void => {
  const tmp = `${file}.${process.pid}.tmp`;
  const { mode } = fs.statSync(file);
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
};

/** The team layer read from, and written to, the project's devcontainer.json in its main checkout. */
export class FileTeamSettings implements TeamSettingsStore {
  private readonly cache = new Map<
    string,
    { mtimeMs: number; read: TeamRead }
  >();

  get(project: Project): TeamRead {
    const file = project.devcontainerPath;
    let mtimeMs: number;
    try {
      ({ mtimeMs } = fs.statSync(file));
    } catch (error) {
      return {
        settings: {},
        forwardPorts: undefined,
        errors: [`could not read ${file}: ${(error as Error).message}`],
      };
    }
    const cached = this.cache.get(file);
    if (cached?.mtimeMs === mtimeMs) {
      return cached.read;
    }
    let read: TeamRead;
    try {
      const { value, errors } = parseDevcontainer(
        fs.readFileSync(file, "utf-8")
      );
      read = {
        ...readTeam(value),
        errors: errors.map((e) => `could not read ${file}: ${e}`),
      };
    } catch (error) {
      read = {
        settings: {},
        forwardPorts: undefined,
        errors: [`could not read ${file}: ${(error as Error).message}`],
      };
    }
    this.cache.set(file, { mtimeMs, read });
    return read;
  }

  update(project: Project, patch: Partial<Record<TeamKey, unknown>>): void {
    const edits = Object.entries(patch)
      .filter(([key]) => isTeamKey(key))
      .map(([key, value]): [JsonPath, unknown] => [
        [...CUSTOM_PATH, key],
        value,
      ]);
    this.edit(project, edits);
  }

  setForwardPorts(project: Project, ports: unknown[]): void {
    this.edit(project, [
      [["forwardPorts"], ports.length > 0 ? ports : undefined],
    ]);
  }

  private edit(project: Project, edits: [JsonPath, unknown][]): void {
    const file = project.devcontainerPath;
    const text = fs.readFileSync(file, "utf-8");
    const next = editDevcontainer(text, edits);
    if (next !== text) {
      writeAtomic(file, next);
    }
    this.cache.delete(file);
  }
}

/** The settings that apply to a project: its `config.json` entry over the team's, key by key (`checks` merge apart). */
export const resolveProjectSettings = (
  team: TeamRead["settings"],
  personal: Record<string, unknown>
): Record<string, unknown> => {
  const { checks: _checks, ...shared } = team;
  return { ...shared, ...personal };
};
