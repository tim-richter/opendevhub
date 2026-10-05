import type { AddProjectResult, Candidate } from "../shared/types";

/** Where the repo sits under its root, as listed in Add project. */
export function candidateLabel(c: Candidate): string {
  if (c.path === c.root) return c.name;
  return c.path.startsWith(`${c.root}/`) ? c.path.slice(c.root.length + 1) : c.path;
}

export function addedDestination(r: AddProjectResult): string {
  return `/p/${encodeURIComponent(r.projectId)}`;
}
