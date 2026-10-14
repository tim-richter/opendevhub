import { Button } from "@opendevhub/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@opendevhub/ui/dialog";
import { Input } from "@opendevhub/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@opendevhub/ui/select";
import {
  ClipboardCheckIcon,
  LinkIcon,
  NetworkIcon,
  PaletteIcon,
  ScanSearchIcon,
  SearchIcon,
  SettingsIcon,
  SparklesIcon,
  UnplugIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

import type { ProjectView } from "../../../shared/types";
import { Tip } from "../../components/tip";
import { useDash } from "../../dashboard-context";
import { matches } from "../../derive";
import { ChecksSettings } from "../checks/checks-settings";
import { SettingsHeader } from "../settings/settings-layout";
import { AppearanceSettings } from "./appearance-settings";
import { LinksSettings } from "./links-settings";
import { OcrProjectSettingsBlock } from "./ocr-project-settings";
import { PersonalizationProjectSettings } from "./personalization-project-settings";
import { HostPortsSettings, PortsSettings } from "./ports-settings";

const GROUPS = [
  { id: "general", label: "General" },
  { id: "integrations", label: "Integrations" },
  { id: "environments", label: "Environments" },
  { id: "review", label: "Review" },
] as const;

interface ProjectSection {
  id: string;
  label: string;
  group: (typeof GROUPS)[number]["id"];
  icon: LucideIcon;
  keywords: string;
  component?: typeof LinksSettings;
}

const SECTIONS: ProjectSection[] = [
  {
    group: "general",
    icon: PaletteIcon,
    id: "appearance",
    keywords: "sidebar short name initials letters color background",
    label: "Appearance",
  },
  {
    component: LinksSettings,
    group: "integrations",
    icon: LinkIcon,
    id: "links",
    keywords: "jira board jql forgejo repository tickets pull requests",
    label: "Tickets and pull requests",
  },
  {
    component: PortsSettings,
    group: "environments",
    icon: NetworkIcon,
    id: "ports",
    keywords: "forward localhost devcontainer network container",
    label: "Forwarded ports",
  },
  {
    component: HostPortsSettings,
    group: "environments",
    icon: UnplugIcon,
    id: "host-ports",
    keywords: "host localhost browser chrome debugging network container",
    label: "Host ports",
  },
  {
    component: PersonalizationProjectSettings,
    group: "environments",
    icon: SparklesIcon,
    id: "personalization",
    keywords:
      "devcontainer features dotfiles setup install script tools git-town personal",
    label: "Personalization",
  },
  {
    component: OcrProjectSettingsBlock,
    group: "review",
    icon: ScanSearchIcon,
    id: "ocr",
    keywords: "model provider api key account gateway pull requests",
    label: "Open Code Review",
  },
  {
    component: ChecksSettings,
    group: "review",
    icon: ClipboardCheckIcon,
    id: "checks",
    keywords: "commands tests lint build timeout devcontainer publish",
    label: "Checks",
  },
];

const ProjectSettingsPanel = ({ view }: { view: ProjectView }) => {
  const { jira, forgejo } = useDash();
  const sections = SECTIONS.filter(
    (section) => section.id !== "links" || jira?.enabled || forgejo?.enabled
  );
  const [selected, setSelected] = useState(sections[0]?.id ?? "ports");
  const [query, setQuery] = useState("");
  const current =
    sections.find((section) => section.id === selected) ?? sections[0];
  const found = sections.filter((section) =>
    matches(query, section.label, section.keywords)
  );

  return (
    <>
      <aside className="bg-sidebar/60 shrink-0 border-b p-3 pr-12 md:w-60 md:overflow-y-auto md:border-r md:border-b-0 md:p-4">
        <div className="mb-4 hidden min-w-0 flex-col gap-0.5 px-2.5 md:flex">
          <p className="text-sm font-semibold">Project settings</p>
          <p
            className="text-muted-foreground truncate text-xs"
            title={view.project.name}
          >
            {view.project.name}
          </p>
        </div>
        <div className="md:hidden">
          <Select value={current?.id} onValueChange={setSelected}>
            <SelectTrigger
              aria-label="Project settings section"
              className="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GROUPS.map((group) => {
                const items = sections.filter(
                  (section) => section.group === group.id
                );
                return (
                  items.length > 0 && (
                    <SelectGroup key={group.id}>
                      <SelectLabel>{group.label}</SelectLabel>
                      {items.map((section) => (
                        <SelectItem key={section.id} value={section.id}>
                          {section.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )
                );
              })}
            </SelectContent>
          </Select>
        </div>
        <nav
          aria-label="Project settings"
          className="flex flex-col gap-4 max-md:hidden"
        >
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
            <Input
              type="search"
              aria-label="Search project settings"
              placeholder="Search settings"
              className="pl-8"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                const [first] = found;
                if (event.key === "Enter" && first) {
                  setSelected(first.id);
                }
              }}
            />
          </div>
          {GROUPS.map((group) => {
            const items = found.filter((section) => section.group === group.id);
            if (items.length === 0) {
              return null;
            }
            return (
              <div key={group.id} className="flex flex-col gap-0.5">
                <h2 className="text-muted-foreground px-2.5 pb-1 text-xs font-semibold tracking-wider uppercase">
                  {group.label}
                </h2>
                {items.map((section) => {
                  const Icon = section.icon;
                  const active = section.id === current?.id;
                  return (
                    <Button
                      key={section.id}
                      type="button"
                      variant="ghost"
                      aria-current={active ? "page" : undefined}
                      onClick={() => setSelected(section.id)}
                      className={cn(
                        "h-auto w-full justify-start gap-2.5 rounded-md px-2.5 py-1.5 text-left",
                        active
                          ? "bg-accent text-foreground font-medium"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                      )}
                    >
                      <Icon className="size-4 shrink-0" />
                      <span className="flex-1 truncate" title={section.label}>
                        {section.label}
                      </span>
                    </Button>
                  );
                })}
              </div>
            );
          })}
          {found.length === 0 && (
            <p className="text-muted-foreground px-2.5 text-sm">No match</p>
          )}
        </nav>
      </aside>
      {/* Keep each section mounted so switching pages preserves unsaved edits. */}
      {sections.map((section) => {
        const Component = section.component;
        let content = null;
        if (section.id === "appearance") {
          content = <AppearanceSettings view={view} />;
        } else if (Component) {
          content = <Component projectId={view.project.id} />;
        }
        return (
          <div
            key={section.id}
            className={cn(
              "min-w-0 flex-1 overflow-y-auto",
              section.id !== current?.id && "hidden"
            )}
          >
            <div className="flex max-w-3xl flex-col gap-8 p-4 sm:p-6 md:p-8 md:pr-14">
              <SettingsHeader
                title="Project settings"
                description={view.project.name}
              />
              {content}
            </div>
          </div>
        );
      })}
    </>
  );
};

/** The project's settings over the current page. */
export const ProjectSettingsDialog = (props: {
  view: ProjectView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const { view, open } = props;
  return (
    <Dialog open={open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex h-[min(52rem,calc(100dvh-2rem))] max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl md:flex-row">
        <DialogTitle className="sr-only">Project settings</DialogTitle>
        <DialogDescription className="sr-only">
          Integration, environment and review settings for {view.project.name}
        </DialogDescription>
        {/* Mounted per opening, so the settings are fetched fresh. */}
        {open && <ProjectSettingsPanel key={view.project.id} view={view} />}
      </DialogContent>
    </Dialog>
  );
};

/** A gear in the project's header that opens its settings. */
export const ProjectSettingsButton = ({ view }: { view: ProjectView }) => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tip label="Project settings">
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          aria-label="Project settings"
          onClick={() => setOpen(true)}
        >
          <SettingsIcon />
        </Button>
      </Tip>
      <ProjectSettingsDialog view={view} open={open} onOpenChange={setOpen} />
    </>
  );
};
