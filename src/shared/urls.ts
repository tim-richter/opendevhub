export function projectUrl(projectId: string, port: number): string {
  return `http://${projectId}.localhost:${port}/`;
}

/**
 * opencode's web UI routes single sessions as `/server/:serverKey/session/:id`;
 * the serverKey encoding is verified in Task 15. Until then, open the project root.
 */
export function sessionUrl(projectBase: string, _sessionId: string): string {
  return projectBase;
}
