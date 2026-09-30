import type { SessionStatus, SessionSummary } from "../../shared/types";
import { relativeTime } from "../derive";

const BADGE: Record<SessionStatus, string> = {
  "needs-permission": "Needs permission",
  "needs-answer": "Question waiting",
  running: "Running",
  idle: "Idle",
};

export function SessionRow(props: { session: SessionSummary; openUrl: string; highlighted: boolean }) {
  const { session, openUrl, highlighted } = props;
  return (
    <li className={`session${highlighted ? " highlight" : ""}`}>
      <span className={`badge status-${session.status}`}>{BADGE[session.status]}</span>
      <span className="session-title">{session.title}</span>
      <span className="muted">{relativeTime(session.updatedAt)}</span>
      <a href={openUrl} target="_blank" rel="noreferrer">
        Open ↗
      </a>
    </li>
  );
}
