import { useState } from "react";
import { fn } from "storybook/test";

import preview from "../../.storybook/preview";
import { ProjectSidebar } from "./project-sidebar";
import type { ProjectSidebarProps } from "./project-sidebar";

const globalLinks = {
  inbox: { href: "#inbox", count: 3 },
  tasks: { href: "#tasks" },
  chats: { href: "#chats" },
  pullRequests: { href: "#pull-requests" },
  tickets: { href: "#tickets" },
};

const projects = [
  {
    id: "inventory",
    name: "inventory-context-service",
    shortName: "ic",
  },
  {
    id: "opendevhub",
    name: "opendevhub",
    shortName: "od",
    activity: "attention" as const,
  },
  {
    id: "customer-ui",
    name: "customer-ui",
    shortName: "cu",
    activity: "running" as const,
  },
];

const projectDetails = {
  status: "Running · 2 containers",
  statusActivity: "running" as const,
  pages: {
    overview: { href: "#overview" },
    todos: { href: "#todos", count: 2 },
    pullRequests: { href: "#project-pull-requests", count: 2 },
    tickets: { href: "#project-tickets" },
  },
  activePage: "overview" as const,
  tasks: [
    {
      id: "user-id-types",
      label: "Fix user ID types",
      href: "#task-user-id-types",
      activity: "attention" as const,
      meta: "4h",
      onArchive: fn(),
    },
    {
      id: "openspec-tasks",
      label: "Implement OpenSpec tasks",
      href: "#task-openspec-tasks",
      activity: "running" as const,
      meta: "6h",
      onArchive: fn(),
    },
  ],
  chats: [
    {
      id: "backend-tsc",
      label: "Fix backend tsc errors for inventory service",
      href: "#chat-backend-tsc",
      active: true,
      activity: "attention" as const,
      meta: "4h",
      onArchive: fn(),
    },
    {
      id: "review-guidelines",
      label: "Code review guidelines",
      href: "#chat-review-guidelines",
      activity: "running" as const,
      meta: "4h",
    },
    {
      id: "openspec",
      label: "Implement OpenSpec changes",
      href: "#chat-openspec",
      meta: "6h",
    },
    {
      id: "untitled",
      label: "Untitled session",
      href: "#chat-untitled",
      meta: "8h",
    },
  ],
  onAddTask: fn(),
  onAddChat: fn(),
};

const meta = preview.meta({
  component: ProjectSidebar,
  title: "Navigation/Project sidebar",
  args: {
    globalLinks,
    projects,
    activeProjectId: "inventory",
    onSelectProject: fn(),
    onAddProject: fn(),
    onCloseProject: fn(),
    projectDetails,
  },
  render: (args) => (
    <div className="bg-background h-[900px]">
      <ProjectSidebar {...args} />
    </div>
  ),
});

export const ActiveProject = meta.story({});

const CollapsiblePreview = (args: ProjectSidebarProps) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-background h-[900px]">
      <ProjectSidebar
        {...args}
        activeProjectId={open ? args.activeProjectId : undefined}
        projectDetails={open ? args.projectDetails : undefined}
        onCloseProject={() => {
          setOpen(false);
          args.onCloseProject?.();
        }}
        onSelectProject={(projectId) => {
          if (projectId === args.activeProjectId) {
            setOpen(true);
          }
          args.onSelectProject(projectId);
        }}
      />
    </div>
  );
};

export const Collapsible = meta.story({
  render: (args) => <CollapsiblePreview {...args} />,
});

export const GlobalPage = meta.story({
  args: {
    activeGlobalPage: "inbox",
    activeProjectId: undefined,
    projectDetails: undefined,
  },
});
