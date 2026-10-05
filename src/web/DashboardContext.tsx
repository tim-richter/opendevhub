import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { DashboardSnapshot } from "../shared/types";
import { type Action, postAction, rescan as postRescan } from "./api";
import { attentionCounts } from "./derive";
import type { Notice } from "./derive";
import { useDashboard } from "./useDashboard";

type Permission = NotificationPermission | "unsupported";

interface DashboardContextValue {
  snapshot: DashboardSnapshot | undefined;
  connected: boolean;
  logs: Record<string, string[]>;
  loadLogs: (projectId: string) => void;
  highlight: Notice | undefined;
  act: (projectId: string, action: Action) => void;
  rescan: () => void;
  scanning: boolean;
  error: string | undefined;
  dismissError: () => void;
  /** Shows a failed request in the error banner. */
  report: (err: unknown) => void;
  /** Opens the New task dialog, with a project preselected when given. */
  newTask: (projectId?: string) => void;
  newTaskFor: { projectId?: string } | undefined;
  closeNewTask: () => void;
  /** Whether the Add project dialog is open. */
  addProjectOpen: boolean;
  openAddProject: () => void;
  closeAddProject: () => void;
  permission: Permission;
  requestPermission: () => void;
}

const Ctx = createContext<DashboardContextValue | undefined>(undefined);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const { snapshot, connected, logs, loadLogs: fetchLogs, highlight } = useDashboard();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [newTaskFor, setNewTaskFor] = useState<{ projectId?: string }>();
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [permission, setPermission] = useState<Permission>(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  // A clicked notification takes the user straight to the session.
  useEffect(() => {
    if (highlight) void navigate(`/p/${encodeURIComponent(highlight.projectId)}?session=${highlight.sessionId}`);
  }, [highlight, navigate]);

  const attention = snapshot ? attentionCounts(snapshot).attention : 0;
  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) opendevhub` : "opendevhub";
  }, [attention]);

  const fail = useCallback((err: unknown) => setError(err instanceof Error ? err.message : String(err)), []);
  const act = useCallback(
    (projectId: string, action: Action) =>
      void postAction(projectId, action).then(() => setError(undefined), fail),
    [fail],
  );
  const rescan = useCallback(() => {
    setScanning(true);
    postRescan()
      .catch(fail)
      .finally(() => setScanning(false));
  }, [fail]);
  const newTask = useCallback((projectId?: string) => setNewTaskFor({ projectId }), []);
  const loadLogs = useCallback((projectId: string) => void fetchLogs(projectId).catch(fail), [fetchLogs, fail]);

  const value = useMemo<DashboardContextValue>(
    () => ({
      snapshot,
      connected,
      logs,
      loadLogs,
      highlight,
      act,
      rescan,
      scanning,
      error,
      dismissError: () => setError(undefined),
      report: fail,
      newTask,
      newTaskFor,
      closeNewTask: () => setNewTaskFor(undefined),
      addProjectOpen,
      openAddProject: () => setAddProjectOpen(true),
      closeAddProject: () => setAddProjectOpen(false),
      permission,
      requestPermission: () => void Notification.requestPermission().then(setPermission),
    }),
    [snapshot, connected, logs, loadLogs, highlight, act, rescan, scanning, error, permission, fail, newTask, newTaskFor, addProjectOpen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDash(): DashboardContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useDash must be used inside DashboardProvider");
  return value;
}

/** Re-render periodically so relative timestamps stay fresh. */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
