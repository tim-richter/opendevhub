import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSnapshot } from "../shared/types";
import { fetchLogs, subscribe } from "./api";
import { type Notice, diffForNotifications } from "./derive";

function showNotification(notice: Notice, onClick: () => void): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const n = new Notification(notice.title, { body: notice.body, tag: notice.key });
  n.onclick = () => {
    window.focus();
    onClick();
    n.close();
  };
}

export function useDashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [highlight, setHighlight] = useState<string>();
  const previous = useRef<DashboardSnapshot | undefined>(undefined);

  useEffect(
    () =>
      subscribe({
        onSnapshot: (next) => {
          for (const notice of diffForNotifications(previous.current, next)) {
            showNotification(notice, () => setHighlight(notice.sessionId));
          }
          previous.current = next;
          setSnapshot(next);
        },
        onLog: ({ projectId, line }) =>
          setLogs((all) => ({ ...all, [projectId]: [...(all[projectId] ?? []), line].slice(-500) })),
        onConnection: setConnected,
      }),
    [],
  );

  const loadLogs = useCallback(async (projectId: string) => {
    const lines = await fetchLogs(projectId);
    setLogs((all) => ({ ...all, [projectId]: lines }));
  }, []);

  return { snapshot, connected, logs, loadLogs, highlight };
}
