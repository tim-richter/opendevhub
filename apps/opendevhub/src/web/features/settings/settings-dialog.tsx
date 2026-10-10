import {
  BellIcon,
  CommandIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GitPullRequestIcon,
  PlugIcon,
  SearchIcon,
  ServerIcon,
  SettingsIcon,
  TicketIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import { Count } from "../../components/status";
import { useDash } from "../../dashboard-context";
import { matches } from "../../derive";
import { useNavigate, useSearchParams } from "../../routing";
import { nodesNeedingAttention } from "../nodes/nodes";
import { RemoteInstancesSettings } from "../nodes/remote-instances";
import { GeneralSettings } from "./general-settings";
import { GitSettings } from "./git-settings";
import {
  integrationConfigured,
  IntegrationSettingsPage,
  IntegrationsSettings,
} from "./integrations-settings";
import { NotificationSettings } from "./notification-settings";
import { ProjectSettings } from "./project-settings";
import { SETTINGS_PARAM, SettingsLink, useSettingsHref } from "./settings-link";
import { ShortcutSettings } from "./shortcut-settings";

const GROUPS = [
  { id: "app", label: "opendevhub" },
  { id: "workspace", label: "Workspace" },
  { id: "integrations", label: "Integrations" },
] as const;

interface SectionDef {
  id: string;
  label: string;
  group: (typeof GROUPS)[number]["id"];
  icon: LucideIcon;
  /** More words the settings search finds the section by. */
  keywords: string;
  render: () => ReactNode;
}

const SECTIONS: SectionDef[] = [
  {
    group: "app",
    icon: SettingsIcon,
    id: "general",
    keywords: "folders roots scan rescan documentation docs",
    label: "General",
    render: () => <GeneralSettings />,
  },
  {
    group: "app",
    icon: BellIcon,
    id: "notifications",
    keywords: "push alerts browser test notification",
    label: "Notifications",
    render: () => <NotificationSettings />,
  },
  {
    group: "app",
    icon: CommandIcon,
    id: "shortcuts",
    keywords: "keyboard keys hotkeys keybindings",
    label: "Shortcuts",
    render: () => <ShortcutSettings />,
  },
  {
    group: "workspace",
    icon: FolderGit2Icon,
    id: "projects",
    keywords: "rename name checks",
    label: "Projects",
    render: () => <ProjectSettings />,
  },
  {
    group: "workspace",
    icon: ServerIcon,
    id: "remote-instances",
    keywords: "nodes machines ssh servers remote",
    label: "Remote instances",
    render: () => <RemoteInstancesSettings />,
  },
  {
    group: "workspace",
    icon: GitBranchIcon,
    id: "git",
    keywords: "ssh keys agent identity user email signing known_hosts",
    label: "Git",
    render: () => <GitSettings />,
  },
  {
    group: "integrations",
    icon: PlugIcon,
    id: "integrations",
    keywords: "forgejo jira connect token services",
    label: "Integrations",
    render: () => <IntegrationsSettings />,
  },
  {
    group: "integrations",
    icon: GitPullRequestIcon,
    id: "forgejo",
    keywords: "pull requests token url",
    label: "Forgejo",
    render: () => <IntegrationSettingsPage id="forgejo" />,
  },
  {
    group: "integrations",
    icon: TicketIcon,
    id: "jira",
    keywords: "tickets token url",
    label: "Jira",
    render: () => <IntegrationSettingsPage id="jira" />,
  },
];

/** The sections the nav lists: an integration's own page shows once it's set up, or while it's open. */
const useVisibleSections = (current: string) => {
  const { forgejo, jira } = useDash();
  const configured: Record<string, boolean> = {
    forgejo: integrationConfigured(forgejo),
    jira: integrationConfigured(jira),
  };
  return SECTIONS.filter((s) => configured[s.id] !== false || s.id === current);
};

const NavLink = (props: {
  section: SectionDef;
  active: boolean;
  badge?: ReactNode;
}) => {
  const Icon = props.section.icon;
  return (
    <SettingsLink
      section={props.section.id}
      replace
      aria-current={props.active ? "page" : undefined}
      className={cn(
        "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
        props.active
          ? "bg-accent text-foreground font-medium"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="flex-1 truncate">{props.section.label}</span>
      {props.badge}
    </SettingsLink>
  );
};

const SettingsNav = (props: {
  sections: SectionDef[];
  current: string;
  badges: Record<string, ReactNode>;
}) => {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const href = useSettingsHref();
  const found = props.sections.filter((s) =>
    matches(query, s.label, s.keywords)
  );
  return (
    <nav aria-label="Settings" className="flex flex-col gap-4">
      <div className="relative">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
        <Input
          type="search"
          aria-label="Search settings"
          placeholder="Search settings"
          className="pl-8"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            const [first] = found;
            if (e.key === "Enter" && first) {
              void navigate(href(first.id), { replace: true });
            }
          }}
        />
      </div>
      {GROUPS.map((group) => {
        const items = found.filter((s) => s.group === group.id);
        if (items.length === 0) {
          return null;
        }
        return (
          <div key={group.id} className="flex flex-col gap-0.5">
            <h2 className="text-muted-foreground px-2.5 pb-1 text-xs font-semibold tracking-wider uppercase">
              {group.label}
            </h2>
            {items.map((s) => (
              <NavLink
                key={s.id}
                section={s}
                active={s.id === props.current}
                badge={props.badges[s.id]}
              />
            ))}
          </div>
        );
      })}
      {found.length === 0 && (
        <p className="text-muted-foreground px-2.5 text-sm">No match</p>
      )}
    </nav>
  );
};

/** On phones the nav becomes a picker above the section. */
const SettingsPicker = (props: { sections: SectionDef[]; current: string }) => {
  const navigate = useNavigate();
  const href = useSettingsHref();
  return (
    <Select
      value={props.current}
      onValueChange={(id) => void navigate(href(id), { replace: true })}
    >
      <SelectTrigger aria-label="Settings section" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {GROUPS.map((group) => (
          <SelectGroup key={group.id}>
            <SelectLabel>{group.label}</SelectLabel>
            {props.sections
              .filter((s) => s.group === group.id)
              .map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.label}
                </SelectItem>
              ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
};

const SettingsPanel = ({ current }: { current: string }) => {
  const { snapshot } = useDash();
  const sections = useVisibleSections(current);
  const section = SECTIONS.find((s) => s.id === current) ?? SECTIONS[0];
  const attention = nodesNeedingAttention(snapshot?.nodes ?? []);
  const badges: Record<string, ReactNode> = {
    "remote-instances": attention > 0 && (
      <Count n={attention} tone="attention" />
    ),
  };
  return (
    <>
      <aside className="bg-sidebar/60 shrink-0 border-b p-3 pr-12 md:w-60 md:overflow-y-auto md:border-r md:border-b-0 md:p-4">
        <div className="md:hidden">
          <SettingsPicker sections={sections} current={section?.id ?? ""} />
        </div>
        <div className="max-md:hidden">
          <SettingsNav
            sections={sections}
            current={section?.id ?? ""}
            badges={badges}
          />
        </div>
      </aside>
      <div key={section?.id} className="min-w-0 flex-1 overflow-y-auto">
        <div className="flex max-w-3xl flex-col gap-8 p-4 sm:p-6 md:p-8 md:pr-14">
          {section?.render()}
        </div>
      </div>
    </>
  );
};

/** Settings over the current page, open while the URL has `?settings=<section>`. */
export const SettingsDialog = () => {
  const [params, setParams] = useSearchParams();
  const current = params.get(SETTINGS_PARAM);
  const close = () =>
    void setParams(
      (prev) => {
        prev.delete(SETTINGS_PARAM);
        return prev;
      },
      { replace: true }
    );
  return (
    <Dialog open={current !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex h-[min(52rem,calc(100dvh-2rem))] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl md:flex-row">
        <DialogTitle className="sr-only">Settings</DialogTitle>
        <DialogDescription className="sr-only">
          opendevhub, workspace and integration settings
        </DialogDescription>
        {current !== null && <SettingsPanel current={current} />}
      </DialogContent>
    </Dialog>
  );
};
