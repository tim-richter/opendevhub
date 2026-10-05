export function projectUrl(projectId: string, port: number): string {
  return `http://${projectId}.localhost:${port}/`;
}

export function sessionUrl(projectBase: string, sessionId: string): string {
  const origin = projectBase.replace(/\/$/, "");
  const key = btoa(origin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${origin}/server/${key}/session/${sessionId}`;
}
