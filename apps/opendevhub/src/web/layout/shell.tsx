import {
  BellIcon,
  CircleDollarSignIcon,
  EraserIcon,
  GitPullRequestIcon,
  LayoutGridIcon,
  ListIcon,
  TicketIcon,
  PlusIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NavLink, Outlet, useLocation, useMatch } from "react-router";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import type { ProjectView } from "../../shared/types";
import {
  checkoutCounts,
  checkoutPath,
  checkouts,
  checkoutTone,
} from "../checkouts";
import { AddProjectDialog } from "../components/add-project-dialog";
import { CommandPalette } from "../components/command-palette";
import { Logo } from "../components/logo";
import { NewTaskDialog } from "../components/new-task-dialog";
import { Count, StatusDot, TONE_LABEL } from "../components/status";
import { useDash } from "../dashboard-context";
import {
  attentionCounts,
  matches,
  projectCounts,
  projectTone,
} from "../derive";
import { nodesNeedingAttention } from "../nodes";
import { formatCost, opensNewTask, projectIdFromPath } from "../tasks";
import { formatUsage } from "../usage";

const FILTER_THRESHOLD = 8;

const NavItem = (props: {
  to: string;
  end?: boolean;
  title?: string;
  children: ReactNode;
  badge?: ReactNode;
  sub?: ReactNode;
}) => {
  const active = useMatch({ end: props.end ?? false, path: props.to }) !== null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} title={props.title}>
        <NavLink to={props.to} end={props.end}>
          {props.children}
        </NavLink>
      </SidebarMenuButton>
      {props.badge && <SidebarMenuBadge>{props.badge}</SidebarMenuBadge>}
      {props.sub}
    </SidebarMenuItem>
  );
};

/** The project's checkouts, shown under it in the sidebar while it is open or needs you. */
const CheckoutItems = ({ view }: { view: ProjectView }) => {
  const location = useLocation();
  return (
    <SidebarMenuSub>
      {checkouts(view).map((c) => {
        const to = checkoutPath(view.project.id, c.target);
        const active =
          location.pathname === to || location.pathname.startsWith(`${to}/`);
        const n = checkoutCounts(view, c.directory);
        const tone = checkoutTone(view, c.directory);
        return (
          <SidebarMenuSubItem key={c.directory}>
            <SidebarMenuSubButton
              asChild
              isActive={active}
              title={`${c.label} — ${TONE_LABEL[tone]}`}
            >
              <NavLink to={to}>
                <StatusDot tone={tone} />
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {n.attention > 0 ? (
                  <Count n={n.attention} tone="attention" />
                ) : (
                  <Count n={n.running} tone="muted" />
                )}
              </NavLink>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        );
      })}
    </SidebarMenuSub>
  );
};

const AppSidebar = ({ onSearch }: { onSearch: () => void }) => {
  const {
    snapshot,
    connected,
    permission,
    requestPermission,
    openAddProject,
    forgejo,
    jira,
  } = useDash();
  const { setOpenMobile } = useSidebar();
  const [filter, setFilter] = useState("");
  const location = useLocation();
  const settingsActive = useMatch("/settings") !== null;

  // oxlint-disable-next-line react/exhaustive-effect-dependencies
  useEffect(() => setOpenMobile(false), [location.pathname, setOpenMobile]);

  if (!snapshot) {
    return null;
  }
  const counts = attentionCounts(snapshot);
  const projects = [...snapshot.projects]
    .toSorted((a, b) => a.project.name.localeCompare(b.project.name))
    .filter((v) => matches(filter, v.project.name, v.project.path));
  const current = projectIdFromPath(location.pathname);
  const isMac =
    typeof navigator !== "undefined" && /mac/iu.test(navigator.platform);

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 pt-1 pb-2 font-semibold tracking-tight">
          <Logo /> opendevhub
        </div>
        <Button
          variant="outline"
          className="text-muted-foreground justify-start shadow-none"
          onClick={onSearch}
        >
          <SearchIcon /> <span className="flex-1 text-left">Jump to…</span>
          <Kbd>{isMac ? "⌘" : "Ctrl"} K</Kbd>
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <NavItem to="/" end>
              <LayoutGridIcon /> Overview
            </NavItem>
            <NavItem
              to="/sessions"
              badge={
                counts.attention > 0 && (
                  <Count n={counts.attention} tone="attention" />
                )
              }
            >
              <ListIcon /> Sessions
            </NavItem>
            <NavItem
              to="/usage"
              title={
                snapshot.usage
                  ? `Spent today: ${formatUsage(snapshot.usage.today)}`
                  : "Usage"
              }
              badge={
                snapshot.usage && (
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {formatCost(snapshot.usage.today.cost)}
                  </span>
                )
              }
            >
              <CircleDollarSignIcon /> Usage
            </NavItem>
            <NavItem to="/cleanup">
              <EraserIcon /> Cleanup
            </NavItem>
            <NavItem
              to="/nodes"
              badge={
                nodesNeedingAttention(snapshot.nodes) > 0 && (
                  <Count
                    n={nodesNeedingAttention(snapshot.nodes)}
                    tone="attention"
                  />
                )
              }
            >
              <ServerIcon /> Nodes
            </NavItem>
            {jira?.enabled && (
              <NavItem to="/jira">
                <TicketIcon /> Jira
              </NavItem>
            )}
            {forgejo?.enabled && (
              <NavItem to="/forgejo">
                <GitPullRequestIcon /> Forgejo
              </NavItem>
            )}
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel className="justify-between pr-8">
            <span>Projects</span>
            <span>{snapshot.projects.length}</span>
          </SidebarGroupLabel>
          <SidebarGroupAction
            title="Add project"
            aria-label="Add project"
            onClick={openAddProject}
          >
            <PlusIcon />
          </SidebarGroupAction>
          {snapshot.projects.length > FILTER_THRESHOLD && (
            <SidebarInput
              className="mb-2"
              placeholder="Filter projects"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          <SidebarMenu>
            {projects.map((view) => {
              const c = projectCounts(view);
              const tone = projectTone(view);
              const expanded = view.project.id === current || c.attention > 0;
              return (
                <NavItem
                  key={view.project.id}
                  end
                  to={`/p/${encodeURIComponent(view.project.id)}`}
                  title={`${view.project.name} — ${TONE_LABEL[tone]}`}
                  sub={expanded && <CheckoutItems view={view} />}
                  badge={
                    c.attention > 0 ? (
                      <Count n={c.attention} tone="attention" />
                    ) : (
                      c.running > 0 && <Count n={c.running} tone="muted" />
                    )
                  }
                >
                  <StatusDot tone={tone} className="mx-1" />
                  <span className="truncate">{view.project.name}</span>
                </NavItem>
              );
            })}
            {projects.length === 0 && (
              <p className="text-muted-foreground px-2 py-1 text-sm">
                {filter ? "No match" : "No projects found"}
              </p>
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                asChild
                variant="ghost"
                size="icon-sm"
                className={cn(
                  settingsActive &&
                    "bg-sidebar-accent text-sidebar-accent-foreground"
                )}
              >
                <NavLink to="/settings" aria-label="Settings">
                  <SettingsIcon />
                </NavLink>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Settings</TooltipContent>
          </Tooltip>
          {permission === "default" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Enable notifications"
                  onClick={requestPermission}
                >
                  <BellIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Enable notifications</TooltipContent>
            </Tooltip>
          )}
          <div className="text-muted-foreground ml-auto flex items-center gap-2 px-2 text-xs">
            <span
              className={cn(
                "size-2 rounded-full",
                connected ? "bg-ok" : "bg-warn animate-pulse"
              )}
            />{" "}
            {connected ? "Live" : "Reconnecting…"}
          </div>
        </div>
      </SidebarFooter>
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

export const Shell = () => {
  const { snapshot, connected, newTask, newTaskFor, addProjectOpen } =
    useDash();
  const [palette, setPalette] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (!palette && !newTaskFor && !addProjectOpen && opensNewTask(e)) {
        e.preventDefault();
        newTask(projectIdFromPath(location.pathname));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, newTaskFor, addProjectOpen, newTask, location.pathname]);

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
      <AppSidebar onSearch={() => setPalette(true)} />
      <SidebarInset className="min-w-0">
        <MobileBar onSearch={() => setPalette(true)} />
        <Banners />
        <div className="px-4 pt-4 pb-12 md:px-8 md:pt-6 md:pb-16">
          <Outlet />
        </div>
      </SidebarInset>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <NewTaskDialog />
      <AddProjectDialog />
    </SidebarProvider>
  );
};
