import type { SpecWorkflow } from "../../shared/types";
import type { RawCommand } from "../opencode/client";

/** The command a spec-first task starts with. */
export const PROPOSE_COMMAND = "opsx-propose";
/** The command that revises a proposed change with review feedback. */
export const UPDATE_COMMAND = "opsx-update";
/** OpenSpec's OPSX commands a spec-first task goes through: propose, revise, implement, archive. */
export const SPEC_COMMANDS = [
  PROPOSE_COMMAND,
  UPDATE_COMMAND,
  "opsx-apply",
  "opsx-archive",
] as const;
const OPSX = /^opsx-/u;

/** Finds the CLI on PATH or through a login shell, where npm, nvm and mise usually put it. */
export const OPENSPEC_CLI_CHECK = [
  "command -v openspec >/dev/null 2>&1 && exit 0",
  "for sh in bash zsh; do",
  '  command -v "$sh" >/dev/null 2>&1 || continue',
  "  \"$sh\" -lc 'command -v openspec' >/dev/null 2>&1 </dev/null && exit 0",
  "done",
  "exit 1",
].join("\n");

/** The commands of OpenSpec's workflow opencode lacks; undefined when it has no `opsx-*` command at all. */
export const specWorkflow = (
  commands: readonly Pick<RawCommand, "name">[]
): SpecWorkflow | undefined => {
  const names = new Set(commands.map((c) => c.name));
  if (![...names].some((n) => OPSX.test(n))) {
    return undefined;
  }
  return { missing: SPEC_COMMANDS.filter((n) => !names.has(n)) };
};
