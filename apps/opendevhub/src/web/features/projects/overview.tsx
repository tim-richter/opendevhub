import { Badge } from "@opendevhub/ui/badge";
import { Button } from "@opendevhub/ui/button";
import {
  ArrowRightIcon,
  FolderPlusIcon,
  MessageSquarePlusIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

import { taskHref } from "../../../shared/urls";
import { Empty, muted, Page, PageHeader } from "../../components/page";
import { When } from "../../components/when";
import { useDash } from "../../dashboard-context";
import { allSessions, needsAttention } from "../../derive";
import { Link } from "../../routing";
import { chatPath, chatTone } from "../chat/chat";
import { projectTasks } from "../checkouts/checkouts";
import { SessionList } from "../sessions/session-list";
import { SettingsLink } from "../settings/settings-link";

interface StartingItem {
  id: string;
  title: string;
  kind: "Task" | "Chat";
  project: string;
  to: string;
  updatedAt: number;
}

const StartingRow = ({ item }: { item: StartingItem }) => (
  <li className="hover:bg-muted/50 grid items-center gap-x-3.5 gap-y-1 border-t px-4 py-2 first:border-t-0 max-md:grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[8.5rem_minmax(0,1fr)_minmax(0,10rem)_6rem_auto]">
    <Badge
      variant="secondary"
      className="bg-running/15 text-running w-fit rounded-md max-md:hidden"
    >
      Starting
    </Badge>
    <Link className="min-w-0 truncate hover:underline" to={item.to}>
      {item.title}
      <span className="text-muted-foreground block text-xs">{item.kind}</span>
    </Link>
    <span className="text-muted-foreground truncate text-sm max-md:hidden">
      {item.project}
    </span>
    <When
      at={item.updatedAt}
      className="text-muted-foreground text-right text-xs whitespace-nowrap max-md:hidden"
    />
    <span className="max-md:hidden" />
    <span className="text-muted-foreground col-span-full flex items-center gap-2 text-xs md:hidden">
      Starting · {item.project}
    </span>
  </li>
);

/** The home dashboard shows conversations in motion and those waiting for a response. */
export const Overview = () => {
  const { snapshot, openAddProject, rescan, scanning } = useDash();
  if (!snapshot) {
    return null;
  }

  const sessions = allSessions(snapshot);
  const attention = sessions.filter((entry) =>
    needsAttention(entry.session.status)
  );
  const working = sessions.filter(
    (entry) => entry.session.status === "running"
  );
  const startingTasks: StartingItem[] = snapshot.projects.flatMap((view) =>
    projectTasks(view)
      .filter(
        (task) =>
          task.state === "starting" &&
          !view.sessions.some((session) => session.task?.id === task.task)
      )
      .map((task) => ({
        id: task.task,
        kind: "Task" as const,
        project: view.project.name,
        title: task.title || "Task",
        to: taskHref(view.project.id, task.task),
        updatedAt: task.updatedAt,
      }))
  );
  const startingChats: StartingItem[] = snapshot.projects.flatMap((view) =>
    view.chats
      .filter(
        (chat) =>
          !chat.archived &&
          chat.step !== "session" &&
          chatTone(chat) === "running"
      )
      .map((chat) => ({
        id: chat.id,
        kind: "Chat" as const,
        project: view.project.name,
        title: chat.title || "Untitled chat",
        to: chatPath(view.project.id, chat.id),
        updatedAt: chat.updatedAt ?? chat.createdAt,
      }))
  );
  const workingCount =
    working.length + startingTasks.length + startingChats.length;
  const activeCount = attention.length + workingCount;

  return (
    <Page className="gap-8">
      <PageHeader
        title="Dashboard"
        description="The tasks and conversations that are working or waiting for you."
        actions={
          snapshot.projects.length > 0 && (
            <>
              <Button asChild variant="outline" size="sm">
                <Link to="/tasks">
                  All tasks <ArrowRightIcon />
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link to="/chats">
                  All chats <ArrowRightIcon />
                </Link>
              </Button>
            </>
          )
        }
      />

      {snapshot.projects.length === 0 ? (
        <Empty title="Add your first project">
          {snapshot.roots.length > 0 ? (
            <p className={cn(muted, "max-w-md text-balance")}>
              No folder with a devcontainer was found under{" "}
              <code className="font-mono text-xs">
                {snapshot.roots.join(", ")}
              </code>
              . Add a git repo, or{" "}
              <SettingsLink
                section="general"
                hash="roots"
                className="text-foreground underline underline-offset-4"
              >
                add more folders in Settings
              </SettingsLink>
              .
            </p>
          ) : (
            <p className={cn(muted, "max-w-md text-balance")}>
              Add the folders that hold your git repos in Settings to get
              started.
            </p>
          )}
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {snapshot.roots.length > 0 ? (
              <>
                <Button onClick={openAddProject}>
                  <PlusIcon /> Add project
                </Button>
                <Button variant="outline" disabled={scanning} onClick={rescan}>
                  <RefreshCwIcon /> {scanning ? "Scanning…" : "Rescan"}
                </Button>
              </>
            ) : (
              <Button asChild>
                <SettingsLink section="general" hash="roots">
                  <FolderPlusIcon /> Add folders
                </SettingsLink>
              </Button>
            )}
          </div>
        </Empty>
      ) : (
        <>
          <div
            className="grid gap-3 sm:grid-cols-3"
            aria-label="Live activity summary"
          >
            <div className="bg-card rounded-xl border px-5 py-4">
              <p className="text-muted-foreground text-xs font-medium">
                Active now
              </p>
              <p className="mt-2 text-3xl font-semibold tabular-nums">
                {activeCount}
              </p>
            </div>
            <div className="bg-card rounded-xl border px-5 py-4">
              <p className="text-attention flex items-center gap-2 text-xs font-medium">
                <span
                  className="bg-attention size-2 rounded-full"
                  aria-hidden
                />
                Needs you
              </p>
              <p className="mt-2 text-3xl font-semibold tabular-nums">
                {attention.length}
              </p>
            </div>
            <div className="bg-card rounded-xl border px-5 py-4">
              <p className="text-running flex items-center gap-2 text-xs font-medium">
                <span className="bg-running size-2 rounded-full" aria-hidden />
                Working
              </p>
              <p className="mt-2 text-3xl font-semibold tabular-nums">
                {workingCount}
              </p>
            </div>
          </div>

          {activeCount === 0 ? (
            <Empty title="All clear for now">
              <p className={muted}>
                Active tasks and conversations will appear here as they start.
              </p>
              <Button asChild variant="outline" className="mt-2">
                <Link to="/chat">
                  <MessageSquarePlusIcon /> New chat
                </Link>
              </Button>
            </Empty>
          ) : (
            <div className="flex flex-col gap-8">
              {attention.length > 0 && (
                <section
                  aria-labelledby="attention-heading"
                  className="space-y-3"
                >
                  <div className="flex items-baseline gap-3">
                    <h2
                      id="attention-heading"
                      className="text-lg font-semibold tracking-tight"
                    >
                      Needs your input
                    </h2>
                    <span className="text-muted-foreground text-sm tabular-nums">
                      {attention.length}
                    </span>
                  </div>
                  <div className="bg-card border-attention/40 overflow-hidden rounded-xl border shadow-[inset_3px_0_var(--attention)]">
                    <SessionList entries={attention} showProject />
                  </div>
                </section>
              )}

              {workingCount > 0 && (
                <section
                  aria-labelledby="working-heading"
                  className="space-y-3"
                >
                  <div className="flex items-baseline gap-3">
                    <h2
                      id="working-heading"
                      className="text-lg font-semibold tracking-tight"
                    >
                      Working now
                    </h2>
                    <span className="text-muted-foreground text-sm tabular-nums">
                      {workingCount}
                    </span>
                  </div>
                  <div className="bg-card overflow-hidden rounded-xl border">
                    <SessionList entries={working} showProject />
                    {(startingTasks.length > 0 || startingChats.length > 0) && (
                      <ul
                        className={working.length > 0 ? "border-t" : undefined}
                      >
                        {[...startingTasks, ...startingChats].map((item) => (
                          <StartingRow key={item.id} item={item} />
                        ))}
                      </ul>
                    )}
                  </div>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </Page>
  );
};
