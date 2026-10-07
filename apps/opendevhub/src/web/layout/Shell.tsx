import { BellIcon, BookOpenIcon, CircleDollarSignIcon, EraserIcon, GitPullRequestIcon, LayoutGridIcon, ListIcon, PlusIcon, RefreshCwIcon, SearchIcon, ServerIcon, SettingsIcon, XIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
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
import { cn } from "@/lib/utils";
import { AddProjectDialog } from "../components/AddProjectDialog";
import { CommandPalette } from "../components/CommandPalette";
import { Logo } from "../components/Logo";
import { NewTaskDialog } from "../components/NewTaskDialog";
import { Count, StatusDot, TONE_LABEL } from "../components/Status";
import { useDash } from "../DashboardContext";
import { checkoutCounts, checkoutPath, checkouts, checkoutTone } from "../checkouts";
import { attentionCounts, matches, projectCounts, projectTone } from "../derive";
import type { ProjectView } from "../../shared/types";
import { nodesNeedingAttention } from "../nodes";
import { formatCost, opensNewTask, projectIdFromPath } from "../tasks";
import { formatUsage } from "../usage";

const FILTER_THRESHOLD = 8;
const DOCS_URL = "https://tim-richter.github.io/opendevhub/";

export function Shell() {
  const { snapshot, connected, newTask, newTaskFor, addProjectOpen } = useDash();
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
        <div className="size-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
        <p className="text-muted-foreground">{connected ? "Loading…" : "Connecting to opendevhub…"}</p>
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
}

function NavItem(props: { to: string; end?: boolean; title?: string; children: ReactNode; badge?: ReactNode; sub?: ReactNode }) {
  const active = useMatch({ path: props.to, end: props.end ?? false }) !== null;
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
}

/** The project's checkouts, shown under it in the sidebar while it is open or needs you. */
function CheckoutItems({ view }: { view: ProjectView }) {
  const location = useLocation();
  return (
    <SidebarMenuSub>
      {checkouts(view).map((c) => {
        const to = checkoutPath(view.project.id, c.target);
        const active = location.pathname === to || location.pathname.startsWith(`${to}/`);
        const n = checkoutCounts(view, c.directory);
        const tone = checkoutTone(view, c.directory);
        return (
          <SidebarMenuSubItem key={c.directory}>
            <SidebarMenuSubButton asChild isActive={active} title={`${c.label} — ${TONE_LABEL[tone]}`}>
              <NavLink to={to}>
                <StatusDot tone={tone} />
                <span className="min-w-0 flex-1 truncate">{c.label}</span>
                {n.attention > 0 ? <Count n={n.attention} tone="attention" /> : <Count n={n.running} tone="muted" />}
              </NavLink>
            </SidebarMenuSubButton>
          </SidebarMenuSubItem>
        );
      })}
    </SidebarMenuSub>
  );
}

function AppSidebar({ onSearch }: { onSearch: () => void }) {
  const { snapshot, connected, rescan, scanning, permission, requestPermission, openAddProject, forgejo } = useDash();
  const { setOpenMobile } = useSidebar();
  const [filter, setFilter] = useState("");
  const location = useLocation();

  useEffect(() => setOpenMobile(false), [location.pathname, setOpenMobile]);

  if (!snapshot) return null;
  const counts = attentionCounts(snapshot);
  const projects = [...snapshot.projects]
    .sort((a, b) => a.project.name.localeCompare(b.project.name))
    .filter((v) => matches(filter, v.project.name, v.project.path));
  const current = projectIdFromPath(location.pathname);
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

  return (
    <Sidebar>
      <SidebarHeader>
        <div className="flex items-center gap-2 px-2 pt-1 pb-2 font-semibold tracking-tight">
          <Logo /> opendevhub
        </div>
        <Button variant="outline" className="justify-start text-muted-foreground shadow-none" onClick={onSearch}>
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
            <NavItem to="/sessions" badge={counts.attention > 0 && <Count n={counts.attention} tone="attention" />}>
              <ListIcon /> Sessions
            </NavItem>
            <NavItem
              to="/usage"
              title={snapshot.usage ? `Spent today: ${formatUsage(snapshot.usage.today)}` : "Usage"}
              badge={snapshot.usage && <span className="text-xs text-muted-foreground tabular-nums">{formatCost(snapshot.usage.today.cost)}</span>}
            >
              <CircleDollarSignIcon /> Usage
            </NavItem>
            <NavItem to="/cleanup">
              <EraserIcon /> Cleanup
            </NavItem>
            <NavItem to="/nodes" badge={nodesNeedingAttention(snapshot.nodes) > 0 && <Count n={nodesNeedingAttention(snapshot.nodes)} tone="attention" />}>
              <ServerIcon /> Nodes
            </NavItem>
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
          <SidebarGroupAction title="Add project" aria-label="Add project" onClick={openAddProject}>
            <PlusIcon />
          </SidebarGroupAction>
          {snapshot.projects.length > FILTER_THRESHOLD && (
            <SidebarInput className="mb-2" placeholder="Filter projects" value={filter} onChange={(e) => setFilter(e.target.value)} />
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
                  badge={c.attention > 0 ? <Count n={c.attention} tone="attention" /> : c.running > 0 && <Count n={c.running} tone="muted" />}
                >
                  <StatusDot tone={tone} className="mx-1" />
                  <span className="truncate">{view.project.name}</span>
                </NavItem>
              );
            })}
            {projects.length === 0 && <p className="px-2 py-1 text-sm text-muted-foreground">{filter ? "No match" : "No projects found"}</p>}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t">
        <SidebarMenu>
          <NavItem to="/settings">
            <SettingsIcon /> Settings
          </NavItem>
          {permission === "default" && (
            <SidebarMenuItem>
              <SidebarMenuButton size="sm" className="text-muted-foreground" onClick={requestPermission}>
                <BellIcon /> Enable notifications
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton size="sm" className="text-muted-foreground" disabled={scanning} onClick={rescan} title={snapshot.roots.join("\n")}>
              <RefreshCwIcon /> {scanning ? "Scanning…" : "Rescan roots"}
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="sm" className="text-muted-foreground">
              <a href={DOCS_URL} target="_blank" rel="noreferrer">
                <BookOpenIcon /> Documentation
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", connected ? "bg-ok" : "animate-pulse bg-warn")} /> {connected ? "Live" : "Reconnecting…"}
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

function MobileBar({ onSearch }: { onSearch: () => void }) {
  const { snapshot } = useDash();
  const counts = snapshot ? attentionCounts(snapshot) : undefined;
  return (
    <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-sidebar px-3 py-2 md:hidden">
      <SidebarTrigger aria-label="Open menu" />
      <span className="inline-flex flex-1 items-center gap-1.5 font-semibold">
        <Logo size={14} /> opendevhub
      </span>
      {counts && <Count n={counts.attention} tone="attention" />}
      <Button variant="ghost" size="icon-sm" aria-label="Search" onClick={onSearch}>
        <SearchIcon />
      </Button>
    </header>
  );
}

function Banners() {
  const { snapshot, connected, error, dismissError } = useDash();
  const banners = [
    !connected && (
      <Alert key="conn" className="border-warn/40 bg-warn/10 text-warn">
        <AlertDescription className="text-warn">Lost connection to opendevhub — retrying…</AlertDescription>
      </Alert>
    ),
    ...(snapshot?.preflight.errors ?? []).map((e) => (
      <Alert key={e} variant="destructive">
        <AlertDescription>{e}</AlertDescription>
      </Alert>
    )),
    error && (
      <Alert key="error" variant="destructive" className="flex items-center justify-between gap-4">
        <AlertDescription>{error}</AlertDescription>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={dismissError}>
          <XIcon />
        </Button>
      </Alert>
    ),
  ].filter(Boolean);
  if (banners.length === 0) return null;
  return <div className="flex flex-col gap-2 px-4 pt-4 md:px-8">{banners}</div>;
}
