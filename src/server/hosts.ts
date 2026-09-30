export type HostRoute = { kind: "dashboard" } | { kind: "project"; projectId: string } | { kind: "reject" };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function classifyHost(host: string | undefined, port: number): HostRoute {
  if (!host) return { kind: "reject" };
  const h = host.toLowerCase();
  if (h === `localhost:${port}` || h === `127.0.0.1:${port}`) return { kind: "dashboard" };
  const suffix = `.localhost:${port}`;
  if (h.endsWith(suffix)) {
    const label = h.slice(0, -suffix.length);
    if (LABEL.test(label)) return { kind: "project", projectId: label };
  }
  return { kind: "reject" };
}
