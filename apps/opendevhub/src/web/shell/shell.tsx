import { Alert, AlertDescription } from "@opendevhub/ui/alert";
import { Button } from "@opendevhub/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@opendevhub/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@opendevhub/ui/tooltip";
import { Outlet, useLocation, useMatches } from "@tanstack/react-router";
import {
  BellIcon,
  CheckIcon,
  ChevronsUpDownIcon,
  FolderGit2Icon,
  GitPullRequestIcon,
  LayoutGridIcon,
  ListTodoIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SquarePenIcon,
  TicketIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarResizeHandle,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

import type { ProjectView } from "../../shared/types";
import { PageLayoutProvider } from "../components/page";
import type { PageLayout } from "../components/page";
import { Count, StatusDot, TONE_LABEL } from "../components/status";
import { Tip } from "../components/tip";
import { useDash } from "../dashboard-context";
import { attentionCounts, projectTone } from "../derive";
import {
  SIDEBAR_CHATS,
  chatActivity,
  chatNeedsYou,
  chatPath,
  chatTone,
  shortAgo,
  sidebarChats,
} from "../features/chat/chat";
import { nodesNeedingAttention } from "../features/nodes/nodes";
import { AddProjectDialog } from "../features/projects/add-project-dialog";
import {
  projectPullsHref,
  projectTicketsHref,
  useProjectLinks,
} from "../features/projects/links-settings";
import {
  projectTodosHref,
  useOpenTodoCount,
} from "../features/projects/project-todos";
import { SettingsDialog } from "../features/settings/settings-dialog";
import {
  SETTINGS_PARAM,
  useSettingsHref,
} from "../features/settings/settings-link";
import { NewTaskDialog } from "../features/tasks/new-task-dialog";
import { projectIdFromPath } from "../features/tasks/tasks";
import { Link, useIsActive, useNavigate, useSearchParams } from "../routing";
import { CommandPalette } from "./command-palette";
import { CurrentProjectProvider, useCurrentProject } from "./current-project";
import { DesktopSidebar } from "./desktop-sidebar";
import { Logo } from "./logo";
import { RightSidebarHost } from "./right-sidebar";
import { useShortcut } from "./use-shortcut";

const NavItem = (props: {
  to: string;
  end?: boolean;
  /** Overrides whether the route makes the item active. */
  active?: boolean;
  children: ReactNode;
  badge?: ReactNode;
}) => {
  const routeActive = useIsActive(props.to, props.end);
  const active = props.active ?? routeActive;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <Link to={props.to} activeOptions={{ exact: props.end }}>
          {props.children}
        </Link>
      </SidebarMenuButton>
      {props.badge && <SidebarMenuBadge>{props.badge}</SidebarMenuBadge>}
    </SidebarMenuItem>
  );
};

/** The project picker: the project the sidebar lists chats of. */
const ProjectPicker = () => {
  const { openAddProject } = useDash();
  const { view, projects, choose } = useCurrentProject();
  const navigate = useNavigate();
  const tone = view ? projectTone(view) : "off";

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  className="data-[state=open]:bg-sidebar-accent"
                >
                  <span className="bg-primary text-primary-foreground grid size-8 shrink-0 place-content-center rounded-md">
                    <Logo size={16} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="text-muted-foreground text-xs">
                      Project
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5 font-semibold">
                      <span className="truncate">
                        {view?.project.name ?? "No project"}
                      </span>
                      {view && <StatusDot tone={tone} />}
                    </span>
                  </span>
                  <ChevronsUpDownIcon className="text-muted-foreground ml-auto" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="right">
              {view
                ? `${view.project.name} — ${TONE_LABEL[tone]}`
                : "No project"}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent
            align="start"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-56"
          >
            <DropdownMenuLabel className="text-muted-foreground text-xs">
              Projects
            </DropdownMenuLabel>
            {projects.map((v) => (
              <DropdownMenuItem
                key={v.project.id}
                onSelect={() => {
                  choose(v.project.id);
                  void navigate("/chat");
                }}
              >
                <StatusDot tone={projectTone(v)} />
                <span className="min-w-0 flex-1 truncate">
                  {v.project.name}
                </span>
                {v.project.id === view?.project.id && <CheckIcon />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={openAddProject}>
              <PlusIcon /> Add project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
};

/** The current project's chats, most recently active first, marked when one waits on the user. */
const ProjectChats = ({ view }: { view: ProjectView }) => {
  const location = useLocation();
  const chats = sidebarChats(view);
  const shown = chats.slice(0, SIDEBAR_CHATS);
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="justify-between pr-8">
        <span>Chats</span>
        <span>{chats.length}</span>
      </SidebarGroupLabel>
      <Tip label="New chat" side="right">
        <SidebarGroupAction aria-label="New chat" asChild>
          <Link to="/chat">
            <PlusIcon />
          </Link>
        </SidebarGroupAction>
      </Tip>
      <SidebarMenu>
        {shown.map((chat) => {
          const to = chatPath(view.project.id, chat.id);
          const needsYou = chatNeedsYou(chat);
          const title = chat.title || "Untitled chat";
          return (
            <SidebarMenuItem key={chat.id}>
              <Tip
                label={`${title}${chat.branch ? ` — ${chat.branch}` : ""}${needsYou ? " — needs you" : ""}`}
                side="right"
              >
                <SidebarMenuButton asChild isActive={location.pathname === to}>
                  <Link to={to}>
                    <StatusDot
                      tone={needsYou ? "attention" : chatTone(chat)}
                      label={needsYou ? "Needs you" : undefined}
                    />
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {shortAgo(chatActivity(chat))}
                    </span>
                  </Link>
                </SidebarMenuButton>
              </Tip>
            </SidebarMenuItem>
          );
        })}
        {chats.length === 0 && (
          <p className="text-muted-foreground px-2 py-1 text-sm">
            No chats in this project yet.
          </p>
        )}
        {chats.length > shown.length && (
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="sm">
              <Link
                to={`/chats?project=${encodeURIComponent(view.project.id)}`}
              >
                <span className="text-muted-foreground text-xs">
                  Show all {chats.length}
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        )}
      </SidebarMenu>
    </SidebarGroup>
  );
};

/** One icon button in the sidebar's footer, with a tooltip and an optional dot. */
const FooterButton = (props: {
  label: string;
  to?: string;
  onClick?: () => void;
  dot?: boolean;
  active?: boolean;
  children: ReactNode;
}) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        asChild={props.to !== undefined}
        variant="ghost"
        size="icon-sm"
        aria-label={props.label}
        className={cn(
          "text-muted-foreground relative",
          props.active && "bg-sidebar-accent text-sidebar-accent-foreground"
        )}
        onClick={props.onClick}
      >
        {props.to === undefined ? (
          props.children
        ) : (
          <Link to={props.to}>
            {props.children}
            {props.dot && (
              <span className="bg-attention absolute top-1 right-1 size-1.5 rounded-full" />
            )}
          </Link>
        )}
      </Button>
    </TooltipTrigger>
    <TooltipContent side="top">{props.label}</TooltipContent>
  </Tooltip>
);

/** The current project's pages: its overview and to-do list, and its pull requests and tickets when Forgejo or Jira is on. */
const ProjectNav = ({ view }: { view: ProjectView }) => {
  const { forgejo, jira } = useDash();
  const location = useLocation();
  const links = useProjectLinks(view.project.id).data;
  const repository = links?.forgejoRepository;
  const ticketsLinked = !!(links?.jiraBoard || links?.jiraJql);
  const openTodos = useOpenTodoCount(view.project.id);
  const todosHref = projectTodosHref(view.project.id);
  return (
    <>
      <NavItem
        to={`/p/${encodeURIComponent(view.project.id)}`}
        active={location.pathname === todosHref ? false : undefined}
      >
        <FolderGit2Icon /> Overview
      </NavItem>
      <NavItem to={todosHref} badge={openTodos > 0 ? openTodos : undefined}>
        <ListTodoIcon /> To-do
      </NavItem>
      {forgejo?.enabled && (
        <NavItem
          to={repository ? projectPullsHref(repository) : "/forgejo"}
          active={location.pathname === "/forgejo"}
        >
          <GitPullRequestIcon /> Pull requests
        </NavItem>
      )}
      {jira?.enabled && (
        <NavItem
          to={links && ticketsLinked ? projectTicketsHref(links) : "/jira"}
          active={location.pathname === "/jira"}
        >
          <TicketIcon /> Tickets
        </NavItem>
      )}
    </>
  );
};

const AppSidebar = () => {
  const { snapshot, connected, permission, requestPermission } = useDash();
  const { view } = useCurrentProject();
  const { setOpenMobile } = useSidebar();
  const [params] = useSearchParams();
  const settingsHref = useSettingsHref();
  const location = useLocation();

  // oxlint-disable-next-line react/exhaustive-effect-dependencies
  useEffect(() => setOpenMobile(false), [location.pathname, setOpenMobile]);

  if (!snapshot) {
    return null;
  }
  const remotes = nodesNeedingAttention(snapshot.nodes);

  return (
    <Sidebar>
      <SidebarHeader>
        <ProjectPicker />
        <SidebarMenu>
          <NavItem to="/chat" end>
            <SquarePenIcon /> New chat
          </NavItem>
          {view && <ProjectNav view={view} />}
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        {view ? (
          <ProjectChats view={view} />
        ) : (
          <p className="text-muted-foreground px-4 py-2 text-sm">
            Add a project to start chatting.
          </p>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t">
        <div className="flex items-center gap-0.5">
          <FooterButton
            label={
              remotes > 0
                ? "Settings — a remote instance needs attention"
                : "Settings"
            }
            to={settingsHref()}
            active={params.has(SETTINGS_PARAM)}
            dot={remotes > 0}
          >
            <SettingsIcon />
          </FooterButton>
          <FooterButton
            label="Dashboard"
            to="/"
            active={location.pathname === "/"}
          >
            <LayoutGridIcon />
          </FooterButton>
          {permission === "default" && (
            <FooterButton
              label="Enable notifications"
              onClick={() => void requestPermission()}
            >
              <BellIcon />
            </FooterButton>
          )}
          <Tip
            label={connected ? "Connected to opendevhub" : "Reconnecting…"}
            side="right"
          >
            <div className="text-muted-foreground ml-auto flex items-center gap-2 px-2 text-xs">
              <span
                className={cn(
                  "size-2 rounded-full",
                  connected ? "bg-ok" : "bg-warn animate-pulse"
                )}
              />{" "}
              {connected ? "Live" : "Reconnecting…"}
            </div>
          </Tip>
        </div>
      </SidebarFooter>
      <SidebarResizeHandle />
    </Sidebar>
  );
};

const MobileBar = ({ onSearch }: { onSearch: () => void }) => {
  const { snapshot } = useDash();
  const counts = snapshot ? attentionCounts(snapshot) : undefined;
  return (
    <header className="bg-sidebar sticky top-0 z-10 flex items-center gap-2 border-b px-3 py-2 md:hidden">
      <SidebarTrigger aria-label="Open menu" />
      <span className="inline-flex flex-1 items-center gap-1.5 font-semibold">
        <Logo size={14} /> opendevhub
      </span>
      {counts && <Count n={counts.attention} tone="attention" />}
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Search"
        onClick={onSearch}
      >
        <SearchIcon />
      </Button>
    </header>
  );
};

const Banners = () => {
  const { snapshot, connected, error, dismissError } = useDash();
  const banners = [
    !connected && (
      <Alert key="conn" className="border-warn/40 bg-warn/10 text-warn">
        <AlertDescription className="text-warn">
          Lost connection to opendevhub — retrying…
        </AlertDescription>
      </Alert>
    ),
    ...(snapshot?.preflight.errors ?? []).map((e) => (
      <Alert key={e} variant="destructive">
        <AlertDescription>{e}</AlertDescription>
      </Alert>
    )),
    error && (
      <Alert
        key="error"
        variant="destructive"
        className="flex items-center justify-between gap-4"
      >
        <AlertDescription>{error}</AlertDescription>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss"
          onClick={dismissError}
        >
          <XIcon />
        </Button>
      </Alert>
    ),
  ].filter(Boolean);
  if (banners.length === 0) {
    return null;
  }
  return <div className="flex flex-col gap-2 px-4 pt-4 md:px-8">{banners}</div>;
};

/** The layout the deepest matched route declares, or `index` when none does. */
const useMatchedLayout = (): PageLayout =>
  useMatches({
    select: (matches) =>
      matches.findLast((m) => m.staticData.layout)?.staticData.layout ??
      "index",
  });

export const Shell = () => {
  const { snapshot, connected, newTask, newTaskFor, addProjectOpen } =
    useDash();
  const [palette, setPalette] = useState(false);
  const location = useLocation();
  const [params] = useSearchParams();
  const settingsOpen = params.has(SETTINGS_PARAM);
  const layout = useMatchedLayout();
  const workspace = layout === "workspace";

  useShortcut("palette", () => setPalette((p) => !p));
  // `n` opens New task for the project whose page is open; none elsewhere, since tasks start in a project.
  const projectId = projectIdFromPath(location.pathname);
  useShortcut(
    "newTask",
    () => {
      if (projectId) {
        newTask(projectId);
      }
    },
    {
      enabled:
        !!projectId &&
        !palette &&
        !settingsOpen &&
        !newTaskFor &&
        !addProjectOpen,
    }
  );

  if (!snapshot) {
    return (
      <div className="grid h-full place-content-center justify-items-center gap-3">
        <div className="border-border border-t-foreground size-5 animate-spin rounded-full border-2" />
        <p className="text-muted-foreground">
          {connected ? "Loading…" : "Connecting to opendevhub…"}
        </p>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <CurrentProjectProvider>
        <div className="md:hidden">
          <AppSidebar />
        </div>
        <DesktopSidebar />
        <RightSidebarHost>
          {/* A workspace page gets a fixed height, so it can pin its bottom to the window's and scroll inside. */}
          <SidebarInset className={cn("min-w-0", workspace && "h-svh")}>
            <MobileBar onSearch={() => setPalette(true)} />
            <Banners />
            <div
              data-layout={layout}
              className={cn(
                "px-4 pt-4 md:px-8 md:pt-6",
                workspace
                  ? "flex min-h-0 flex-1 flex-col overflow-y-auto"
                  : "pb-12 md:pb-16"
              )}
            >
              <PageLayoutProvider value={layout}>
                <Outlet />
              </PageLayoutProvider>
            </div>
          </SidebarInset>
        </RightSidebarHost>
        <CommandPalette open={palette} onClose={() => setPalette(false)} />
        <NewTaskDialog />
        <AddProjectDialog />
        <SettingsDialog />
      </CurrentProjectProvider>
    </SidebarProvider>
  );
};
