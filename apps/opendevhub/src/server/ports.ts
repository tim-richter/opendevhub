export interface PortSpec {
  containerPort: number;
  label?: string;
}

export interface SkippedPort {
  entry: string;
  reason: string;
}

const INVALID_NUMBER = "not a valid port number (1–65535)";
const LOCAL_ENTRY = /^(?:(?:localhost|127\.0\.0\.1):)?(?<g1>\d+)$/iu;
const SERVICE_ENTRY = /^[^:\s]+:\d+$/u;

const describe = (entry: unknown): string =>
  typeof entry === "string" ? entry : (JSON.stringify(entry) ?? String(entry));

const isPort = (n: number): boolean =>
  Number.isInteger(n) && n >= 1 && n <= 65_535;

const toPort = (entry: unknown): number | string => {
  if (typeof entry === "number") {
    return isPort(entry) ? entry : INVALID_NUMBER;
  }
  if (typeof entry !== "string") {
    return "not a valid port entry";
  }
  const text = entry.trim();
  const local = text.match(LOCAL_ENTRY);
  if (local) {
    const n = Number(local[1]);
    return isPort(n) ? n : INVALID_NUMBER;
  }
  if (SERVICE_ENTRY.test(text)) {
    return "service hosts are not supported yet";
  }
  return "not a valid port entry";
};

export const parseForwardPorts = (
  forwardPorts: unknown,
  portsAttributes: unknown
): { ports: PortSpec[]; skipped: SkippedPort[] } => {
  const attrs =
    portsAttributes && typeof portsAttributes === "object"
      ? (portsAttributes as Record<string, unknown>)
      : {};
  const ports: PortSpec[] = [];
  const skipped: SkippedPort[] = [];
  const seen = new Set<number>();
  for (const entry of Array.isArray(forwardPorts) ? forwardPorts : []) {
    const port = toPort(entry);
    if (typeof port === "string") {
      skipped.push({ entry: describe(entry), reason: port });
      continue;
    }
    if (seen.has(port)) {
      continue;
    }
    seen.add(port);
    const label = (attrs[String(port)] as { label?: unknown } | undefined)
      ?.label;
    ports.push(
      typeof label === "string"
        ? { containerPort: port, label }
        : { containerPort: port }
    );
  }
  return { ports, skipped };
};
