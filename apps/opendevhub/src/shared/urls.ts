export const projectUrl = (projectId: string, port: number): string =>
  `http://${projectId}.localhost:${port}/`;

export const sessionUrl = (projectBase: string, sessionId: string): string => {
  const origin = projectBase.replace(/\/$/u, "");
  const key = btoa(origin)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${origin}/server/${key}/session/${sessionId}`;
};
