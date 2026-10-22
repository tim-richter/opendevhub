import { Button } from "@opendevhub/ui/button";
import { ProjectSidebar } from "@opendevhub/ui/project-sidebar";
import type {
  SidebarProject,
  SidebarProjectDetails,
} from "@opendevhub/ui/project-sidebar";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { BellIcon, SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { taskHref } from "../../shared/urls";
import { archiveChat, archiveTask } from "../api";
import { STATE_LABEL } from "../components/status";
import { Tip } from "../components/tip";
import { useDash } from "../dashboard-context";
import { attentionCounts, projectCounts, projectTone } from "../derive";
import type { Tone } from "../derive";
import {
  chatActivity,
  chatNeedsYou,
  chatPath,
  chatTone,
  shortAgo,
  sidebarChats,
} from "../features/chat/chat";
import { projectTasks } from "../features/checkouts/checkouts";
import {
  projectPullsHref,
  projectTicketsHref,
  useProjectLinks,
} from "../features/projects/links-settings";
import {
  projectTodosHref,
  useOpenTodoCount,
} from "../features/projects/project-todos";
import { useSettingsHref } from "../features/settings/settings-link";
import { useNavigate, useSearchParams } from "../routing";
import { useCurrentProject } from "./current-project";

const activityOf = (
  tone: Tone
): "attention" | "running" | "healthy" | "idle" => {
  if (tone === "attention" || tone === "error") {
    return "attention";
  }
  if (tone === "running" || tone === "busy") {
    return "running";
  }
  return tone === "ok" ? "healthy" : "idle";
};

const shortName = (name: string): string => {
  const words = name.split(/[-_\s]+/u).filter(Boolean);
  return words.length > 1
    ? words
        .slice(0, 2)
        .map((word) => word[0])
        .join("")
        .toLowerCase()
    : name.slice(0, 2).toLowerCase();
};

const globalPageOf = (pathname: string) => {
  if (pathname === "/") {
    return "inbox";
  }
  if (pathname === "/tasks") {
    return "tasks";
  }
  if (pathname === "/chats" || pathname.startsWith("/chat")) {
    return "chats";
  }
  if (pathname.startsWith("/forgejo")) {
    return "pullRequests";
  }
  if (pathname.startsWith("/jira")) {
    return "tickets";
  }
  return undefined;
};

const projectPageOf = (pathname: string, projectId: string) => {
  if (pathname === `/p/${encodeURIComponent(projectId)}`) {
    return "overview";
  }
  if (pathname === projectTodosHref(projectId)) {
    return "todos";
  }
  return undefined;
};

export const DesktopSidebar = () => {
  const {
    snapshot,
    connected,
    permission,
    requestPermission,
    openAddProject,
    newTask,
    report,
  } = useDash();
  const { view, projects, choose } = useCurrentProject();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settingsHref = useSettingsHref();
  const [params] = useSearchParams();
  const [panelOpen, setPanelOpen] = useState(true);
  const [selectedProjectId, setSelectedProjectId] = useState(view?.project.id);
  const selectedView =
    projects.find(
      (projectView) => projectView.project.id === selectedProjectId
    ) ?? view;
  const links = useProjectLinks(selectedView?.project.id).data;
  const openTodos = useOpenTodoCount(selectedView?.project.id);
  const { pathname } = useLocation();

  useEffect(() => {
    setSelectedProjectId(view?.project.id);
    setPanelOpen(true);
  }, [view?.project.id]);

  if (!snapshot) {
    return null;
  }

  const sidebarProjects: SidebarProject[] = projects.map((projectView) => ({
    id: projectView.project.id,
    name: projectView.project.name,
    shortName:
      projectView.appearance?.shortName ?? shortName(projectView.project.name),
    color: projectView.appearance?.color,
    activity:
      projectView.runtime.containerState === "running"
        ? activityOf(projectTone(projectView))
        : undefined,
    count: projectCounts(projectView).attention,
  }));
  const activeProjectId = selectedView?.project.id;
  const repository = links?.forgejoRepository;
  const ticketsLinked = !!(links?.jiraBoard || links?.jiraJql);
  const runningContainers = selectedView
    ? Number(selectedView.runtime.containerState === "running") +
      selectedView.environments.filter(
        (environment) => environment.runtime.containerState === "running"
      ).length
    : 0;
  const projectDetails: SidebarProjectDetails | undefined = selectedView
    ? {
        status: `${STATE_LABEL[selectedView.runtime.containerState]} · ${runningContainers} ${runningContainers === 1 ? "container" : "containers"}`,
        statusActivity: activityOf(projectTone(selectedView)),
        pages: {
          overview: {
            href: `/p/${encodeURIComponent(selectedView.project.id)}`,
          },
          todos: {
            href: projectTodosHref(selectedView.project.id),
            count: openTodos,
          },
          pullRequests: {
            href: repository ? projectPullsHref(repository) : "/forgejo",
          },
          tickets: {
            href: links && ticketsLinked ? projectTicketsHref(links) : "/jira",
          },
        },
        activePage: projectPageOf(pathname, selectedView.project.id),
        tasks: projectTasks(selectedView)
          .filter(
            (task) => task.state === "starting" || task.state === "running"
          )
          .map((task) => {
            const taskPath = taskHref(selectedView.project.id, task.task);
            const href = taskHref(
              selectedView.project.id,
              task.task,
              task.waiting === undefined ? {} : { v: task.waiting }
            );
            let activity: "attention" | "running" | "idle" = "idle";
            if (task.attention) {
              activity = "attention";
            } else if (task.running) {
              activity = "running";
            }
            return {
              id: task.task,
              label: task.title || "Task",
              href,
              active:
                pathname === taskPath || pathname.startsWith(`${taskPath}/`),
              activity,
              meta: shortAgo(task.updatedAt),
              onArchive: async () => {
                try {
                  await archiveTask(selectedView.project.id, task.task);
                  await queryClient.invalidateQueries({
                    queryKey: ["archived-tasks", selectedView.project.id],
                  });
                  if (
                    pathname === taskPath ||
                    pathname.startsWith(`${taskPath}/`)
                  ) {
                    await navigate("/tasks");
                  }
                } catch (error) {
                  report(error);
                }
              },
            };
          }),
        chats: sidebarChats(selectedView).map((chat) => ({
          id: chat.id,
          label: chat.title || "Untitled chat",
          href: chatPath(selectedView.project.id, chat.id),
          active: pathname === chatPath(selectedView.project.id, chat.id),
          activity: activityOf(
            chatNeedsYou(chat) ? "attention" : chatTone(chat)
          ),
          meta: shortAgo(chatActivity(chat)),
          onArchive: async () => {
            try {
              await archiveChat(selectedView.project.id, chat.id);
              if (pathname === chatPath(selectedView.project.id, chat.id)) {
                await navigate("/chats");
              }
            } catch (error) {
              report(error);
            }
          },
        })),
        onAddTask: () => newTask(selectedView.project.id),
        onAddChat: () => void navigate("/chat"),
      }
    : undefined;
  const globalPage = globalPageOf(pathname);

  return (
    <div className="sticky top-0 hidden h-svh shrink-0 md:block">
      <ProjectSidebar
        globalLinks={{
          inbox: { href: "/", count: attentionCounts(snapshot).attention },
          tasks: { href: "/tasks" },
          chats: { href: "/chats" },
          pullRequests: { href: "/forgejo" },
          tickets: { href: "/jira" },
        }}
        activeGlobalPage={globalPage}
        projects={sidebarProjects}
        onSelectProject={(projectId) => {
          setSelectedProjectId(projectId);
          setPanelOpen(true);
          if (activeProjectId !== projectId) {
            choose(projectId);
          }
        }}
        onAddProject={openAddProject}
        onNavigate={(href) => void navigate(href)}
        footer={
          <div className="flex flex-col items-center gap-2">
            <Tip label="Settings" side="right">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Settings"
                aria-current={params.has("settings") ? "page" : undefined}
                onClick={() => void navigate(settingsHref())}
              >
                <SettingsIcon />
              </Button>
            </Tip>
            {permission === "default" && (
              <Tip label="Enable notifications" side="right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Enable notifications"
                  onClick={() => void requestPermission()}
                >
                  <BellIcon />
                </Button>
              </Tip>
            )}
            <Tip label={connected ? "Connected" : "Reconnecting"} side="right">
              <span
                className={`mb-1 size-2 rounded-full ${connected ? "bg-ok" : "bg-warn animate-pulse"}`}
                role="img"
                aria-label={connected ? "Connected" : "Reconnecting"}
              />
            </Tip>
          </div>
        }
        {...(panelOpen && activeProjectId && projectDetails
          ? {
              activeProjectId,
              projectDetails,
              onCloseProject: () => setPanelOpen(false),
            }
          : {})}
      />
    </div>
  );
};
