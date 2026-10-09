import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";

import type { ForgejoSettings, ForgejoSettingsInput } from "../shared/forgejo";
import type { IntegrationSettings } from "../shared/integrations";
import type {
  JiraSettings,
  JiraSettingsInput,
  JiraTaskSource,
} from "../shared/jira";
import type { DashboardSnapshot } from "../shared/types";
import {
  fetchJiraSettings,
  saveJiraSettings,
  fetchForgejoSettings,
  saveForgejoSettings,
  postAction,
  rescan as postRescan,
} from "./api";
import type { Action } from "./api";
import { attentionCounts } from "./derive";
import { enablePush, pushSupported, syncPush } from "./push";
import { useNavigate } from "./routing";
import { useDashboard } from "./use-dashboard";

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

const SETTINGS_KEY = ["settings"] as const;
const JIRA_SETTINGS_KEY = [...SETTINGS_KEY, "jira"] as const;
const FORGEJO_SETTINGS_KEY = [...SETTINGS_KEY, "forgejo"] as const;

/** Drops an integration's cached data when its connection differs from the cached settings. */
const dropIfChanged = (
  queryClient: QueryClient,
  key: readonly unknown[],
  next: IntegrationSettings,
  integration: string
) => {
  const previous = queryClient.getQueryData<IntegrationSettings>(key);
  if (
    previous?.url !== next.url ||
    previous.enabled !== next.enabled ||
    previous.hasToken !== next.hasToken
  ) {
    queryClient.removeQueries({ queryKey: [integration] });
  }
};

const Ctx = createContext<DashboardContextValue | undefined>(undefined);

export const DashboardProvider = ({ children }: { children: ReactNode }) => {
  const { snapshot, connected, logs, loadLogs: fetchLogs } = useDashboard();
  const [highlight, setHighlight] = useState<Highlight>();
  const navigate = useNavigate();
  const [error, setError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [newTaskFor, setNewTaskFor] =
    useState<DashboardContextValue["newTaskFor"]>();
  const queryClient = useQueryClient();
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [permission, setPermission] = useState<Permission>(() =>
    pushSupported() ? Notification.permission : "unsupported"
  );
  // Settings load as soon as the page does, in parallel with the live connection, so integration
  // pages can start their own requests without waiting for the socket.
  const jiraSettings = useQuery({
    queryFn: async () => {
      const settings = await fetchJiraSettings();
      // Cached tickets, restored from an earlier visit too, may belong to another connection.
      dropIfChanged(queryClient, JIRA_SETTINGS_KEY, settings, "jira");
      return settings;
    },
    queryKey: JIRA_SETTINGS_KEY,
    // Restored settings let integration pages start at once; this confirms them in the background.
    refetchOnMount: "always",
    staleTime: Number.POSITIVE_INFINITY,
  });
  const forgejoSettings = useQuery({
    queryFn: async () => {
      const settings = await fetchForgejoSettings();
      dropIfChanged(queryClient, FORGEJO_SETTINGS_KEY, settings, "forgejo");
      return settings;
    },
    queryKey: FORGEJO_SETTINGS_KEY,
    refetchOnMount: "always",
    staleTime: Number.POSITIVE_INFINITY,
  });
  const jira = jiraSettings.data;
  const jiraError = jiraSettings.error?.message;
  const forgejo = forgejoSettings.data;
  const forgejoError = forgejoSettings.error?.message;

  // A reconnect may follow a server restart with different settings.
  const wasConnected = useRef(false);
  useEffect(() => {
    if (!connected) {
      return;
    }
    if (wasConnected.current) {
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    }
    wasConnected.current = true;
  }, [connected, queryClient]);

  const updateJira = useCallback(
    async (input: JiraSettingsInput) => {
      const settings = await saveJiraSettings(input);
      await queryClient.cancelQueries({ queryKey: ["jira"] });
      queryClient.removeQueries({ queryKey: ["jira"] });
      queryClient.setQueryData<JiraSettings>(JIRA_SETTINGS_KEY, settings);
    },
    [queryClient]
  );

  const updateForgejo = useCallback(
    async (input: ForgejoSettingsInput) => {
      const settings = await saveForgejoSettings(input);
      await queryClient.cancelQueries({ queryKey: ["forgejo"] });
      queryClient.removeQueries({ queryKey: ["forgejo"] });
      queryClient.setQueryData<ForgejoSettings>(FORGEJO_SETTINGS_KEY, settings);
    },
    [queryClient]
  );

  // A clicked notification takes the user straight to the session: the service worker focuses this
  // tab and says which one.
  useEffect(() => {
    if (highlight) {
      void navigate(
        `/p/${encodeURIComponent(highlight.projectId)}?session=${encodeURIComponent(highlight.sessionId)}`
      );
    }
  }, [highlight, navigate]);
  useEffect(() => {
    if (!pushSupported()) {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | { type?: string; projectId?: unknown; sessionId?: unknown }
        | undefined;
      if (
        data?.type === "open" &&
        typeof data.projectId === "string" &&
        typeof data.sessionId === "string"
      ) {
        setHighlight({ projectId: data.projectId, sessionId: data.sessionId });
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () =>
      navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);

  const attention = snapshot ? attentionCounts(snapshot).attention : 0;
  useEffect(() => {
    document.title = attention > 0 ? `(${attention}) opendevhub` : "opendevhub";
  }, [attention]);

  const fail = useCallback(
    (err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    []
  );
  const act = useCallback(
    (projectId: string, action: Action) =>
      void postAction(projectId, action).then(() => setError(undefined), fail),
    [fail]
  );
  const rescan = useCallback(() => {
    setScanning(true);
    postRescan()
      .catch(fail)
      .finally(() => setScanning(false));
  }, [fail]);
  const newTask = useCallback(
    (projectId?: string, draft?: NewTaskDraft) =>
      setNewTaskFor({ projectId, ...draft }),
    []
  );
  const loadLogs = useCallback(
    (projectId: string) => void fetchLogs(projectId).catch(fail),
    [fetchLogs, fail]
  );
  const requestPermission = useCallback(
    () =>
      void enablePush()
        .then(setPermission)
        .catch((err) => {
          setPermission(Notification.permission);
          fail(err);
        }),
    [fail]
  );

  // Keeps this browser subscribed (and moves it to new keys) without a click once permission is granted.
  useEffect(() => {
    syncPush().catch((err) =>
      console.warn("opendevhub: push subscription failed", err)
    );
  }, []);

  const value = useMemo<DashboardContextValue>(
    () => ({
      act,
      addProjectOpen,
      closeAddProject: () => setAddProjectOpen(false),
      closeNewTask: () => setNewTaskFor(undefined),
      connected,
      dismissError: () => setError(undefined),
      error,
      forgejo,
      forgejoError,
      highlight,
      jira,
      jiraError,
      loadLogs,
      logs,
      newTask,
      newTaskFor,
      openAddProject: () => setAddProjectOpen(true),
      permission,
      report: fail,
      requestPermission,
      rescan,
      scanning,
      snapshot,
      updateForgejo,
      updateJira,
    }),
    [
      snapshot,
      connected,
      logs,
      loadLogs,
      highlight,
      act,
      rescan,
      scanning,
      error,
      permission,
      requestPermission,
      fail,
      newTask,
      newTaskFor,
      addProjectOpen,
      forgejo,
      forgejoError,
      updateForgejo,
      jira,
      jiraError,
      updateJira,
    ]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

export const useDash = (): DashboardContextValue => {
  const value = useContext(Ctx);
  if (!value) {
    throw new Error("useDash must be used inside DashboardProvider");
  }
  return value;
};

/** Re-render periodically so relative timestamps stay fresh. */
export const useNow = (intervalMs = 30_000): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
};
