/** `<envId>.localhost` reaches an environment's opencode; a main environment's id is its project's. */
export type HostRoute =
  | { kind: "dashboard" }
  | { kind: "env"; envId: string }
  | { kind: "reject" };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export const classifyHost = (
  host: string | undefined,
  port: number
): HostRoute => {
  if (!host) {
    return { kind: "reject" };
  }
  const h = host.toLowerCase();
  if (h === `localhost:${port}` || h === `127.0.0.1:${port}`) {
    return { kind: "dashboard" };
  }
  const suffix = `.localhost:${port}`;
  if (h.endsWith(suffix)) {
    const label = h.slice(0, -suffix.length);
    if (LABEL.test(label)) {
      return { envId: label, kind: "env" };
    }
  }
  return { kind: "reject" };
};
