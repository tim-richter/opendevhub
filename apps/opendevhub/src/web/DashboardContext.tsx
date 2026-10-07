import type { JiraSettings, JiraSettingsInput, JiraTaskSource } from "../shared/jira";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { DashboardSnapshot } from "../shared/types";
import type { ForgejoSettings, ForgejoSettingsInput } from "../shared/forgejo";
import { type Action, fetchJiraSettings, saveJiraSettings, fetchForgejoSettings, saveForgejoSettings, postAction, rescan as postRescan } from "./api";
import { attentionCounts } from "./derive";
import { enablePush, pushSupported, syncPush } from "./push";
import { useDashboard } from "./useDashboard";

type Permission = NotificationPermission | "unsupported";

/** The session a clicked notification points at. */
interface Highlight {
  projectId: string;
  sessionId: string;
}

export interface NewTaskDraft {
  prompt?: string;
  title?: string;
  base?: string;
  jira?: JiraTaskSource;
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
  newTask: (projectId?: string, draft?: NewTaskDraft) => void;
  newTaskFor: (NewTaskDraft & { projectId?: string }) | undefined;
  closeNewTask: () => void;
  /** Whether the Add project dialog is open. */
  addProjectOpen: boolean;
  openAddProject: () => void;
  closeAddProject: () => void;
  permission: Permission;
  requestPermission: () => void;
  jira: JiraSettings | undefined;
  jiraError: string | undefined;
  updateJira: (input: JiraSettingsInput) => Promise<void>;
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
  const [newTaskFor, setNewTaskFor] = useState<DashboardContextValue["newTaskFor"]>();
  const queryClient = useQueryClient();
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [permission, setPermission] = useState<Permission>(() => (pushSupported() ? Notification.permission : "unsupported"));
  const [jira, setJira] = useState<JiraSettings>();
  const [jiraError, setJiraError] = useState<string>();
  const [forgejo, setForgejo] = useState<ForgejoSettings>();
  const [forgejoError, setForgejoError] = useState<string>();

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    void fetchJiraSettings().then(
      (settings) => { if (!cancelled) { setJira(settings); setJiraError(undefined); } },
      (err: unknown) => { if (!cancelled) setJiraError(err instanceof Error ? err.message : String(err)); },
    );
    void fetchForgejoSettings().then(
      (settings) => { if (!cancelled) { queryClient.removeQueries({ queryKey: ["forgejo"] }); setForgejo(settings); setForgejoError(undefined); } },
      (err: unknown) => { if (!cancelled) setForgejoError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { cancelled = true; };
  }, [connected, queryClient]);

  const updateJira = useCallback(async (input: JiraSettingsInput) => {
    const settings = await saveJiraSettings(input);
    setJira(settings);
    setJiraError(undefined);
  }, []);

  const updateForgejo = useCallback(async (input: ForgejoSettingsInput) => {
    const settings = await saveForgejoSettings(input);
    await queryClient.cancelQueries({ queryKey: ["forgejo"] });
    queryClient.removeQueries({ queryKey: ["forgejo"] });
    setForgejo(settings);
    setForgejoError(undefined);
  }, [queryClient]);

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
  const newTask = useCallback((projectId?: string, draft?: NewTaskDraft) => setNewTaskFor({ projectId, ...draft }), []);
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
      jira,
      jiraError,
      updateJira,
      forgejo,
      forgejoError,
      updateForgejo,
    }),
    [snapshot, connected, logs, loadLogs, highlight, act, rescan, scanning, error, permission, requestPermission, fail, newTask, newTaskFor, addProjectOpen, forgejo, forgejoError, updateForgejo, jira, jiraError, updateJira],
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
