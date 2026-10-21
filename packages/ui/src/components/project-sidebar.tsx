import {
  Archive,
  ChevronDown,
  Folder,
  GitPullRequest,
  Inbox,
  MessageSquare,
  Plus,
  SquareCheckBig,
  Ticket,
  X,
} from "lucide-react";
import type {
  ComponentProps,
  MouseEvent,
  ReactElement,
  ReactNode,
} from "react";
import { useId, useState } from "react";

import { cn } from "../utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

type GlobalPage = "inbox" | "tasks" | "chats" | "pullRequests" | "tickets";
type ProjectPage = "overview" | "pullRequests" | "tickets";
type Activity = "attention" | "running" | "healthy" | "idle";

interface SidebarGlobalLink {
  href: string;
  count?: number;
}

interface SidebarProject {
  id: string;
  name: string;
  shortName: string;
  color?: string;
  activity?: Activity;
  count?: number;
}

const projectColors: Record<string, string> = {
  slate: "bg-slate-300 text-slate-950 dark:bg-slate-700 dark:text-slate-50",
  red: "bg-red-300 text-red-950 dark:bg-red-800 dark:text-red-50",
  orange:
    "bg-orange-300 text-orange-950 dark:bg-orange-800 dark:text-orange-50",
  amber: "bg-amber-300 text-amber-950 dark:bg-amber-700 dark:text-amber-50",
  green: "bg-green-300 text-green-950 dark:bg-green-800 dark:text-green-50",
  teal: "bg-teal-300 text-teal-950 dark:bg-teal-800 dark:text-teal-50",
  blue: "bg-blue-300 text-blue-950 dark:bg-blue-800 dark:text-blue-50",
  violet:
    "bg-violet-300 text-violet-950 dark:bg-violet-800 dark:text-violet-50",
  pink: "bg-pink-300 text-pink-950 dark:bg-pink-800 dark:text-pink-50",
};

interface SidebarEntry {
  id: string;
  label: string;
  href: string;
  active?: boolean;
  activity?: Activity;
  meta?: string;
  onArchive?: () => void;
}

interface SidebarProjectDetails {
  status?: string;
  statusActivity?: Activity;
  pages: Record<ProjectPage, SidebarGlobalLink>;
  activePage?: ProjectPage;
  tasks?: readonly SidebarEntry[];
  chats?: readonly SidebarEntry[];
  onAddTask?: () => void;
  onAddChat?: () => void;
}

type ProjectSidebarProps = Omit<ComponentProps<"aside">, "children"> & {
  globalLinks: Record<GlobalPage, SidebarGlobalLink>;
  activeGlobalPage?: GlobalPage;
  projects: readonly SidebarProject[];
  onSelectProject: (projectId: string) => void;
  onAddProject?: () => void;
  onNavigate?: (href: string) => void;
  activeProjectId?: string;
  projectDetails?: SidebarProjectDetails;
  onCloseProject?: () => void;
  footer?: ReactNode;
};

const handleLinkClick = (
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onNavigate?: (href: string) => void
) => {
  if (
    !onNavigate ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  onNavigate(href);
};

const globalPages = [
  { id: "inbox", label: "Inbox / Dashboard", icon: Inbox },
  { id: "tasks", label: "Tasks", icon: SquareCheckBig },
  { id: "chats", label: "Chats", icon: MessageSquare },
  { id: "pullRequests", label: "Pull requests", icon: GitPullRequest },
  { id: "tickets", label: "Tickets", icon: Ticket },
] as const;

const projectPages = [
  { id: "overview", label: "Overview", icon: Folder },
  { id: "pullRequests", label: "Pull requests", icon: GitPullRequest },
  { id: "tickets", label: "Tickets", icon: Ticket },
] as const;

const activityColors: Record<Activity, string> = {
  attention: "bg-attention",
  running: "bg-running",
  healthy: "bg-ok",
  idle: "border border-muted-foreground bg-transparent",
};

const ActivityDot = ({ activity }: { activity: Activity }) => (
  <span
    aria-hidden="true"
    className={cn("size-2 shrink-0 rounded-full", activityColors[activity])}
  />
);

const SidebarTip = ({
  label,
  children,
}: {
  label: string;
  children: ReactElement;
}) => (
  <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="right">{label}</TooltipContent>
  </Tooltip>
);

const SidebarEntries = ({
  kind,
  entries,
  addAction,
  onNavigate,
  open,
  onToggle,
  listId,
}: {
  kind: "tasks" | "chats";
  entries: readonly SidebarEntry[];
  addAction?: () => void;
  onNavigate?: (href: string) => void;
  open: boolean;
  onToggle: () => void;
  listId: string;
}) => {
  const label = kind === "tasks" ? "Tasks" : "Chats";
  return (
    <section
      aria-label={label}
      className={cn(
        "mt-5 flex min-h-0 min-w-0 flex-col",
        open ? "flex-1" : "shrink-0"
      )}
    >
      <div className="text-muted-foreground flex shrink-0 items-center justify-between px-3 text-xs">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={onToggle}
          className="hover:text-sidebar-foreground focus-visible:ring-sidebar-ring flex min-w-0 items-center gap-1 rounded py-1 outline-none focus-visible:ring-2"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              !open && "-rotate-90"
            )}
          />
          {label}
        </button>
        <span className="flex items-center gap-2">
          <span>{entries.length}</span>
          {addAction && (
            <button
              type="button"
              aria-label={`Add ${kind === "tasks" ? "task" : "chat"}`}
              onClick={addAction}
              className="hover:bg-sidebar-accent focus-visible:ring-sidebar-ring rounded p-0.5 outline-none focus-visible:ring-2"
            >
              <Plus className="size-3.5" />
            </button>
          )}
        </span>
      </div>
      <ul
        id={listId}
        hidden={!open}
        className="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto"
      >
        {entries.map((entry) => (
          <li key={entry.id}>
            <ContextMenu>
              <SidebarTip label={entry.label}>
                <ContextMenuTrigger asChild>
                  <a
                    href={entry.href}
                    onClick={(event) =>
                      handleLinkClick(event, entry.href, onNavigate)
                    }
                    aria-current={entry.active ? "page" : undefined}
                    className={cn(
                      "text-sidebar-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex min-w-0 items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2",
                      entry.active && "bg-sidebar-accent"
                    )}
                  >
                    <ActivityDot activity={entry.activity ?? "idle"} />
                    <span className="min-w-0 flex-1 truncate">
                      {entry.label}
                    </span>
                    {entry.meta && (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {entry.meta}
                      </span>
                    )}
                  </a>
                </ContextMenuTrigger>
              </SidebarTip>
              <ContextMenuContent>
                <ContextMenuItem asChild>
                  <a href={entry.href} rel="noopener" target="_blank">
                    Open in new tab
                  </a>
                </ContextMenuItem>
                {entry.onArchive && (
                  <ContextMenuItem onSelect={() => entry.onArchive?.()}>
                    <Archive /> Archive {kind === "tasks" ? "task" : "chat"}
                  </ContextMenuItem>
                )}
              </ContextMenuContent>
            </ContextMenu>
          </li>
        ))}
      </ul>
    </section>
  );
};

const ProjectSidebar = ({
  globalLinks,
  activeGlobalPage,
  projects,
  activeProjectId,
  onSelectProject,
  onAddProject,
  onNavigate,
  onCloseProject,
  projectDetails,
  footer,
  className,
  ...props
}: ProjectSidebarProps) => {
  const [tasksOpen, setTasksOpen] = useState(true);
  const [chatsOpen, setChatsOpen] = useState(true);
  const sectionId = useId();
  const activeProject = projects.find(
    (project) => project.id === activeProjectId
  );

  return (
    <aside
      data-slot="project-sidebar"
      className={cn(
        "bg-sidebar text-sidebar-foreground border-sidebar-border flex h-full min-h-0 w-fit max-w-full overflow-hidden border-r",
        className
      )}
      {...props}
    >
      <div className="border-sidebar-border flex w-14 shrink-0 flex-col items-center border-r py-3">
        <nav aria-label="Global pages" className="w-full px-2">
          <ul className="space-y-1">
            {globalPages.map(({ id, label, icon: Icon }) => {
              const link = globalLinks[id];
              return (
                <li key={id}>
                  <SidebarTip label={label}>
                    <a
                      href={link.href}
                      onClick={(event) =>
                        handleLinkClick(event, link.href, onNavigate)
                      }
                      aria-label={label}
                      aria-current={
                        activeGlobalPage === id ? "page" : undefined
                      }
                      className={cn(
                        "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring relative flex size-10 items-center justify-center rounded-lg outline-none focus-visible:ring-2",
                        activeGlobalPage === id &&
                          "bg-sidebar-accent text-sidebar-accent-foreground"
                      )}
                    >
                      <Icon aria-hidden="true" className="size-4" />
                      {Boolean(link.count) && (
                        <span className="bg-attention text-attention-foreground absolute -top-1 -right-1 flex min-w-5 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold">
                          {link.count}
                        </span>
                      )}
                    </a>
                  </SidebarTip>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="bg-sidebar-border my-3 h-px w-8 shrink-0" />

        <nav
          aria-label="Projects"
          className="min-h-0 w-full flex-1 overflow-y-auto px-2"
        >
          <ul className="space-y-2">
            {projects.map((project) => {
              const isActive = project.id === activeProjectId;
              const hasNotifications = (project.count ?? 0) > 0;
              return (
                <li key={project.id}>
                  <SidebarTip label={project.name}>
                    <button
                      type="button"
                      aria-label={project.name}
                      aria-expanded={isActive && Boolean(projectDetails)}
                      onClick={() => onSelectProject(project.id)}
                      className={cn(
                        "bg-sidebar-accent text-sidebar-accent-foreground focus-visible:ring-sidebar-ring relative flex size-10 items-center justify-center rounded-lg text-xs font-semibold outline-none focus-visible:ring-2",
                        isActive &&
                          "bg-sidebar-primary text-sidebar-primary-foreground",
                        !isActive &&
                          (project.color
                            ? "hover:brightness-95 dark:hover:brightness-110"
                            : "hover:bg-sidebar-accent/70"),
                        project.color && projectColors[project.color]
                      )}
                    >
                      <span className="max-w-full truncate px-1">
                        {project.shortName}
                      </span>
                      {hasNotifications && (
                        <span
                          aria-hidden="true"
                          className="bg-attention text-attention-foreground absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full px-1 text-[0.625rem] font-semibold"
                        >
                          {project.count}
                        </span>
                      )}
                      {!hasNotifications &&
                        project.activity &&
                        project.activity !== "idle" && (
                          <span
                            aria-hidden="true"
                            className={cn(
                              "border-sidebar absolute -top-1 -right-1 size-3 rounded-full border-2",
                              activityColors[project.activity]
                            )}
                          />
                        )}
                      {hasNotifications && (
                        <span className="sr-only">
                          {project.count} notifications
                        </span>
                      )}
                    </button>
                  </SidebarTip>
                </li>
              );
            })}
            {onAddProject && (
              <li>
                <SidebarTip label="Add project">
                  <button
                    type="button"
                    aria-label="Add project"
                    onClick={onAddProject}
                    className="text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring border-sidebar-border flex size-10 items-center justify-center rounded-lg border border-dashed outline-none focus-visible:ring-2"
                  >
                    <Plus aria-hidden="true" className="size-4" />
                  </button>
                </SidebarTip>
              </li>
            )}
          </ul>
        </nav>
        {footer && <div className="mt-3 shrink-0">{footer}</div>}
      </div>

      {activeProject && projectDetails && (
        <div className="flex min-h-0 w-72 min-w-0 flex-col">
          <div className="border-sidebar-border relative border-b px-5 py-5 pr-11">
            {onCloseProject && (
              <SidebarTip label="Close project sidebar">
                <button
                  type="button"
                  aria-label="Close project sidebar"
                  onClick={onCloseProject}
                  className="text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring absolute top-4 right-3 flex size-6 items-center justify-center rounded-md outline-none focus-visible:ring-2"
                >
                  <X aria-hidden="true" className="size-3.5" />
                </button>
              </SidebarTip>
            )}
            <p className="text-muted-foreground text-xs">Project</p>
            <SidebarTip label={activeProject.name}>
              <p className="mt-1 truncate text-sm font-semibold">
                {activeProject.name}
              </p>
            </SidebarTip>
            {projectDetails.status && (
              <p className="text-muted-foreground mt-2 flex items-center gap-2 text-xs">
                {projectDetails.statusActivity && (
                  <ActivityDot activity={projectDetails.statusActivity} />
                )}
                {projectDetails.status}
              </p>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 py-4">
            <nav
              aria-label={`${activeProject.name} pages`}
              className="shrink-0"
            >
              <ul className="space-y-1">
                {projectPages.map(({ id, label, icon: Icon }) => {
                  const link = projectDetails.pages[id];
                  return (
                    <li key={id}>
                      <a
                        href={link.href}
                        onClick={(event) =>
                          handleLinkClick(event, link.href, onNavigate)
                        }
                        aria-current={
                          projectDetails.activePage === id ? "page" : undefined
                        }
                        className={cn(
                          "text-sidebar-foreground hover:bg-sidebar-accent focus-visible:ring-sidebar-ring flex items-center gap-3 rounded-lg px-3 py-2 text-sm outline-none focus-visible:ring-2",
                          projectDetails.activePage === id &&
                            "bg-sidebar-accent font-medium"
                        )}
                      >
                        <Icon
                          aria-hidden="true"
                          className="size-3.5 shrink-0"
                        />
                        <span className="min-w-0 flex-1 truncate">{label}</span>
                        {link.count !== undefined && link.count > 0 && (
                          <span className="text-muted-foreground text-xs">
                            {link.count}
                          </span>
                        )}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>

            {projectDetails.tasks && (
              <SidebarEntries
                kind="tasks"
                entries={projectDetails.tasks}
                addAction={projectDetails.onAddTask}
                onNavigate={onNavigate}
                open={tasksOpen}
                onToggle={() => setTasksOpen((current) => !current)}
                listId={`${sectionId}-tasks`}
              />
            )}
            {projectDetails.chats && (
              <SidebarEntries
                kind="chats"
                entries={projectDetails.chats}
                addAction={projectDetails.onAddChat}
                onNavigate={onNavigate}
                open={chatsOpen}
                onToggle={() => setChatsOpen((current) => !current)}
                listId={`${sectionId}-chats`}
              />
            )}
          </div>
        </div>
      )}
    </aside>
  );
};

export { ProjectSidebar };
export type {
  GlobalPage,
  ProjectPage,
  ProjectSidebarProps,
  SidebarEntry,
  SidebarGlobalLink,
  SidebarProject,
  SidebarProjectDetails,
};
