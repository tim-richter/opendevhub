import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSnapshot } from "../shared/types";
import { fetchLogs, subscribe } from "./api";
import { type Notice, diffForNotifications } from "./derive";

const MAX_LOG_LINES = 500;
const LOG_FLUSH_MS = 150;

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
  const [highlight, setHighlight] = useState<Notice>();
  const previous = useRef<DashboardSnapshot | undefined>(undefined);

  useEffect(() => {
    // A build can stream hundreds of lines a second; each state update re-renders every dashboard
    // consumer, so apply them in batches.
    let pending: Record<string, string[]> = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const batch = pending;
      pending = {};
      setLogs((all) => {
        const next = { ...all };
        for (const [id, lines] of Object.entries(batch)) next[id] = [...(all[id] ?? []), ...lines].slice(-MAX_LOG_LINES);
        return next;
      });
    };
    const unsubscribe = subscribe({
      onSnapshot: (next) => {
        for (const notice of diffForNotifications(previous.current, next)) {
          showNotification(notice, () => setHighlight(notice));
        }
        previous.current = next;
        setSnapshot(next);
      },
      onLog: ({ projectId, line }) => {
        (pending[projectId] ??= []).push(line);
        timer ??= setTimeout(flush, LOG_FLUSH_MS);
      },
      onConnection: setConnected,
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  const loadLogs = useCallback(async (projectId: string) => {
    const lines = await fetchLogs(projectId);
    setLogs((all) => ({ ...all, [projectId]: lines }));
  }, []);

  return { snapshot, connected, logs, loadLogs, highlight, setHighlight };
}
