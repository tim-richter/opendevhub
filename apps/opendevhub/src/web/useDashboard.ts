import { useCallback, useEffect, useState } from "react";
import type { DashboardSnapshot } from "../shared/types";
import { fetchLogs, subscribe } from "./api";
import { staleNotificationTags } from "./derive";
import { closeNotifications } from "./push";

const MAX_LOG_LINES = 500;
const LOG_FLUSH_MS = 150;

export function useDashboard() {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>();
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<Record<string, string[]>>({});

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
        // Notifications come from the server by Web Push; drop the ones answered meanwhile.
        void closeNotifications((tags) => staleNotificationTags(next, tags)).catch(() => {});
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

  return { snapshot, connected, logs, loadLogs };
}
