import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { DashboardSnapshot } from "../shared/types";
import type { ForgejoSettings, ForgejoSettingsInput } from "../shared/forgejo";
import { type Action, fetchForgejoSettings, saveForgejoSettings, postAction, rescan as postRescan } from "./api";
import { attentionCounts } from "./derive";
import { enablePush, pushSupported, syncPush } from "./push";
import { useDashboard } from "./useDashboard";

type Permission = NotificationPermission | "unsupported";

/** The session a clicked notification points at. */
interface Highlight {
  projectId: string;
  sessionId: string;
}

interface DashboardContextValue {
  snapshot: DashboardSnapshot | undefined;
  connected: boolean;
  logs: Record<string, string[]>;
  loadLogs: (projectId: string) => void;
  highlight: Highlight | undefined;
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
  forgejo: ForgejoSettings | undefined;
  forgejoError: string | undefined;
  updateForgejo: (input: ForgejoSettingsInput) => Promise<void>;
}

const Ctx = createContext<DashboardContextValue | undefined>(undefined);

export function DashboardProvider({ children }: { children: ReactNode }) {
  const { snapshot, connected, logs, loadLogs: fetchLogs } = useDashboard();
  const [highlight, setHighlight] = useState<Highlight>();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [newTaskFor, setNewTaskFor] = useState<{ projectId?: string }>();
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [permission, setPermission] = useState<Permission>(() => (pushSupported() ? Notification.permission : "unsupported"));
  const [forgejo, setForgejo] = useState<ForgejoSettings>();
  const [forgejoError, setForgejoError] = useState<string>();

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void fetchForgejoSettings().then(
      (settings) => { if (!cancelled) { setForgejo(settings); setForgejoError(undefined); } },
      (err: unknown) => { if (!cancelled) setForgejoError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { cancelled = true; };
  }, [connected]);

  const updateForgejo = useCallback(async (input: ForgejoSettingsInput) => {
    const settings = await saveForgejoSettings(input);
    setForgejo(settings);
    setForgejoError(undefined);
  }, []);

  // A clicked notification takes the user straight to the session: the service worker focuses this
  // tab and says which one.
  useEffect(() => {
    if (highlight) void navigate(`/p/${encodeURIComponent(highlight.projectId)}?session=${encodeURIComponent(highlight.sessionId)}`);
  }, [highlight, navigate]);
  useEffect(() => {
    if (!pushSupported()) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; projectId?: unknown; sessionId?: unknown } | undefined;
      if (data?.type === "open" && typeof data.projectId === "string" && typeof data.sessionId === "string") {
        setHighlight({ projectId: data.projectId, sessionId: data.sessionId });
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

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
  const requestPermission = useCallback(
    () =>
      void enablePush()
        .then(setPermission)
        .catch((err: unknown) => {
          setPermission(Notification.permission);
          fail(err);
        }),
    [fail],
  );

  // Keeps this browser subscribed (and moves it to new keys) without a click once permission is granted.
  useEffect(() => {
    syncPush().catch((err: unknown) => console.warn("opendevhub: push subscription failed", err));
  }, []);

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
      requestPermission,
      forgejo,
      forgejoError,
      updateForgejo,
    }),
    [snapshot, connected, logs, loadLogs, highlight, act, rescan, scanning, error, permission, requestPermission, fail, newTask, newTaskFor, addProjectOpen, forgejo, forgejoError, updateForgejo],
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
