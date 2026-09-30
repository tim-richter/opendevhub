import type { ForwardedPort } from "../../shared/types";

export function PortsRow({ ports }: { ports: ForwardedPort[] }) {
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
    </ul>
  );
}
