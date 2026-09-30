import type { ForwardedPort } from "../../shared/types";

export function PortsRow({ ports, relay }: { ports: ForwardedPort[]; relay?: "active" | "unavailable" }) {
  return (
    <ul className="ports" aria-label="Forwarded ports">
      {ports.map((p) => {
        if (p.status === "forwarded") {
          const moved = p.hostPort !== p.containerPort;
          return (
            <li key={`f-${p.containerPort}`}>
              <a href={`http://localhost:${p.hostPort}/`} target="_blank" rel="noreferrer">
                {p.label ?? "port"} · {p.containerPort} → localhost:{moved ? <strong>{p.hostPort}</strong> : p.hostPort} ↗
              </a>
            </li>
          );
        }
        if (p.status === "failed") {
          return (
            <li key={`x-${p.containerPort}`} className="muted" title={p.reason}>
              {p.label ? `${p.label} · ` : ""}
              {p.containerPort} not forwarded
            </li>
          );
        }
        return (
          <li key={`s-${p.entry}`} className="muted" title={p.reason}>
            {p.entry} skipped
          </li>
        );
      })}
      {relay && (
        <li
          className="muted"
          title={
            relay === "active"
              ? "Connections go through a relay inside the container, so apps bound to localhost there are reachable"
              : "No relay in the container; only apps listening on 0.0.0.0 are reachable (see the project log)"
          }
        >
          {relay === "active" ? "via relay" : "direct"}
        </li>
      )}
    </ul>
  );
}
