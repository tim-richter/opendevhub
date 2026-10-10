import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  KanbanIcon,
  ListIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  TicketIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

import {
  JIRA_DEFAULT_QUERY,
  jiraKanban,
  jiraQueryParams,
  jiraTaskPrompt,
  parseJiraQuery,
} from "../../../shared/jira";
import type {
  JiraBoardColumn,
  JiraCatalog,
  JiraScope,
  JiraSort,
  JiraStatusFilter,
  JiraTaskSource,
  JiraTicket,
  JiraTicketQuery,
  JiraTicketSummary,
  JiraTickets,
} from "../../../shared/jira";
import {
  fetchJiraBoardColumns,
  fetchJiraCatalog,
  fetchJiraTicket,
  fetchJiraTickets,
} from "../../api";
import { Choice } from "../../components/choice";
import type { ChoiceOption } from "../../components/choice";
import { MarkdownBody } from "../../components/markdown-body";
import {
  Chip,
  Empty,
  Note,
  Page,
  PageHeader,
  Section,
} from "../../components/page";
import { When } from "../../components/when";
import { useDash } from "../../dashboard-context";
import { Link, useSearchParams } from "../../routing";
import { ProvenanceBreadcrumb } from "../activity/provenance-breadcrumb";
import { PullRequestBadge } from "../forgejo/pull-request-badge";
import { SettingsLink } from "../settings/settings-link";
import { taskPath } from "../tasks/tasks";
import { useJiraQuery, useTicketLinks } from "./use-jira";

/** Shows cached data while it refreshes; "loading" only until the first result arrives. */
const useJiraResource = <T,>(
  key: readonly unknown[],
  load: (signal: AbortSignal) => Promise<T>
) => {
  const { data, error, isFetching, isLoading, refetch } = useJiraQuery(
    key,
    load
  );
  return {
    busy: isFetching,
    data,
    error: error?.message,
    loading: isLoading,
    refresh: () => void refetch(),
  };
};

const JiraGate = ({ children }: { children: ReactNode }) => {
  const { jira, jiraError } = useDash();
  if (!jira && !jiraError) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Loading Jira settings…
      </p>
    );
  }
  if (!jira?.enabled) {
    return (
      <Empty title="Jira is disabled">
        {jiraError && <Note error>{jiraError}</Note>}
        <p className="text-muted-foreground text-sm">
          Connect your Jira instance to browse tickets and create tasks.
        </p>
        <Button asChild variant="outline">
          <SettingsLink section="jira">Open settings</SettingsLink>
        </Button>
      </Empty>
    );
  }
  return children;
};

const STATUS_OPTIONS: ChoiceOption[] = [
  { label: "Any status", value: "any" },
  { label: "Not done", value: "open" },
  { label: "To do", value: "todo" },
  { label: "In progress", value: "progress" },
  { label: "Done", value: "done" },
];
const SORT_OPTIONS: ChoiceOption[] = [
  { label: "Recently updated", value: "updated" },
  { label: "Recently created", value: "created" },
  { label: "Priority", value: "priority" },
  { label: "Board rank", value: "rank" },
];
const SCOPE_LABELS: Record<Exclude<JiraScope, "board" | "filter">, string> = {
  all: "All tickets",
  assigned: "Assigned to me",
  reported: "Reported by me",
  watching: "Watching",
};

/** One picker for every view: fixed scopes, then boards, then favourite filters. */
const viewValue = (query: JiraTicketQuery): string => {
  if (query.scope === "board") {
    return `board:${query.board}`;
  }
  if (query.scope === "filter") {
    return `filter:${query.filter}`;
  }
  return query.scope;
};

const viewOptions = (
  query: JiraTicketQuery,
  catalog: JiraCatalog | undefined
): ChoiceOption[] => {
  const boards = [...(catalog?.boards ?? [])];
  const filters = [...(catalog?.filters ?? [])];
  // Keep the current board or filter selectable while the catalog loads or after it disappears.
  if (query.board && !boards.some((b) => b.id === query.board)) {
    boards.unshift({ id: query.board, name: `Board ${query.board}`, type: "" });
  }
  if (query.filter && !filters.some((f) => f.id === query.filter)) {
    filters.unshift({ id: query.filter, name: `Filter ${query.filter}` });
  }
  return [
    ...Object.entries(SCOPE_LABELS).map(([value, label]) => ({
      label,
      value,
    })),
    ...boards.map((b) => ({
      group: "Boards",
      label: b.project ? `${b.name} (${b.project})` : b.name,
      title: b.type ? `${b.type} board` : undefined,
      value: `board:${b.id}`,
    })),
    ...filters.map((f) => ({
      group: "Favourite filters",
      label: f.name,
      value: `filter:${f.id}`,
    })),
  ];
};

const viewQuery = (value: string): Partial<JiraTicketQuery> => {
  const [scope, id] = value.split(":");
  if (scope === "board") {
    return { board: Number(id), scope, sprint: false };
  }
  if (scope === "filter") {
    return { filter: Number(id), scope };
  }
  return { scope: scope as JiraScope };
};

const VIEW_PHRASES: Record<Exclude<JiraScope, "board" | "filter">, string> = {
  all: "All Jira tickets",
  assigned: "Jira tickets assigned to you",
  reported: "Jira tickets you reported",
  watching: "Jira tickets you watch",
};

const LIST_TITLES: Record<Exclude<JiraScope, "board" | "filter">, string> = {
  all: "Tickets",
  assigned: "Assigned to you",
  reported: "Reported by you",
  watching: "Watching",
};

const boardName = (query: JiraTicketQuery, catalog?: JiraCatalog) =>
  catalog?.boards.find((b) => b.id === query.board)?.name ??
  `Board ${query.board}`;
const filterName = (query: JiraTicketQuery, catalog?: JiraCatalog) =>
  catalog?.filters.find((f) => f.id === query.filter)?.name ??
  `Filter ${query.filter}`;

/** A sentence for the page header describing what the list shows. */
const viewPhrase = (query: JiraTicketQuery, catalog?: JiraCatalog): string => {
  if (query.scope === "board") {
    const name = boardName(query, catalog);
    return query.sprint
      ? `Jira tickets in the active sprint of ${name}`
      : `Jira tickets on ${name}`;
  }
  if (query.scope === "filter") {
    return `Jira tickets in the filter “${filterName(query, catalog)}”`;
  }
  return VIEW_PHRASES[query.scope];
};

const listTitle = (query: JiraTicketQuery, catalog?: JiraCatalog): string => {
  if (query.scope === "board") {
    const name = boardName(query, catalog);
    return query.sprint ? `${name} · active sprint` : name;
  }
  if (query.scope === "filter") {
    return filterName(query, catalog);
  }
  return LIST_TITLES[query.scope];
};

type JiraLayout = "list" | "board";

/** The kanban layout loads up to this many tickets, page by page. */
const KANBAN_LIMIT = 500;

const checkedItem =
  "aria-checked:bg-accent aria-checked:text-accent-foreground";

/** The page URL: the API query plus the page-only layout. */
const pageParams = (
  query: Partial<JiraTicketQuery>,
  layout: JiraLayout
): URLSearchParams => {
  const params = jiraQueryParams(query);
  if (layout === "board") {
    params.set("layout", "board");
  }
  return params;
};

const ticketPath = (ticket: JiraTicketSummary, params: URLSearchParams) =>
  `/jira/${encodeURIComponent(ticket.key)}${params.size ? `?${params}` : ""}`;

const ticketMeta = (ticket: JiraTicketSummary) =>
  `${ticket.key} · ${ticket.type}${ticket.priority ? ` · ${ticket.priority}` : ""}${ticket.assignee ? ` · ${ticket.assignee}` : ""}`;

const LayoutToggle = (props: {
  value: JiraLayout;
  onChange: (layout: JiraLayout) => void;
}) => (
  <ToggleGroup
    type="single"
    variant="outline"
    size="sm"
    aria-label="Layout"
    value={props.value}
    onValueChange={(v) => v && props.onChange(v as JiraLayout)}
  >
    <ToggleGroupItem className={checkedItem} value="list" aria-label="List">
      <ListIcon /> List
    </ToggleGroupItem>
    <ToggleGroupItem className={checkedItem} value="board" aria-label="Board">
      <KanbanIcon /> Board
    </ToggleGroupItem>
  </ToggleGroup>
);

const Loading = ({ children }: { children: ReactNode }) => (
  <p role="status" className="text-muted-foreground text-sm">
    {children}
  </p>
);

const Failure = ({ children }: { children: ReactNode }) => (
  <div role="alert">
    <Note error>{children}</Note>
  </div>
);

const NoTickets = () => (
  <Empty title="No tickets">
    <p className="text-muted-foreground text-sm">
      No tickets match these filters in projects accessible to your token.
    </p>
  </Empty>
);

const TicketList = (props: {
  query: JiraTicketQuery;
  title: string;
  params: URLSearchParams;
  change: (patch: Partial<JiraTicketQuery>) => void;
}) => {
  const { query, params, change } = props;
  const { startAt } = query;
  const { data, error, loading } = useJiraResource<JiraTickets>(
    ["tickets", jiraQueryParams(query).toString()],
    (signal) => fetchJiraTickets(query, signal)
  );
  return (
    <>
      {loading && <Loading>Loading tickets…</Loading>}
      {error && <Failure>{error}</Failure>}
      {data?.tickets.length === 0 && <NoTickets />}
      {!!data?.tickets.length && (
        <Section
          title={props.title}
          hint={`${startAt + 1}–${startAt + data.tickets.length} of ${data.total}`}
        >
          <ul className="divide-y">
            {data.tickets.map((ticket) => (
              <li key={ticket.key}>
                <Link
                  className="hover:bg-muted/50 focus-visible:outline-ring flex items-start gap-3 px-4 py-3 transition-colors focus-visible:outline-2"
                  to={ticketPath(ticket, params)}
                >
                  <TicketIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium break-words">{ticket.title}</p>
                    <p className="text-muted-foreground text-sm">
                      {ticketMeta(ticket)}
                    </p>
                  </div>
                  <Chip>{ticket.status}</Chip>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {data && (
        <div className="flex gap-2">
          {startAt > 0 && (
            <Button variant="outline" onClick={() => change({})}>
              First page
            </Button>
          )}
          {data.nextStartAt !== undefined && (
            <Button
              variant="outline"
              onClick={() => change({ startAt: data.nextStartAt })}
            >
              Next page
            </Button>
          )}
        </div>
      )}
    </>
  );
};

/** Every page of a query, up to the kanban limit. */
const fetchAllTickets = async (
  query: JiraTicketQuery,
  signal: AbortSignal
): Promise<JiraTickets> => {
  const tickets: JiraTicketSummary[] = [];
  let page = await fetchJiraTickets({ ...query, startAt: 0 }, signal);
  tickets.push(...page.tickets);
  while (page.nextStartAt !== undefined && tickets.length < KANBAN_LIMIT) {
    // Pages depend on each other's offsets, so they load one after another.
    // oxlint-disable-next-line no-await-in-loop
    page = await fetchJiraTickets(
      { ...query, startAt: page.nextStartAt },
      signal
    );
    tickets.push(...page.tickets);
  }
  return { tickets: tickets.slice(0, KANBAN_LIMIT), total: page.total };
};

const KanbanCard = (props: {
  ticket: JiraTicketSummary;
  params: URLSearchParams;
}) => {
  const { ticket } = props;
  return (
    <li>
      <Link
        className="bg-card hover:bg-muted/50 focus-visible:outline-ring flex flex-col gap-1 rounded-lg border px-3 py-2 shadow-xs transition-colors focus-visible:outline-2"
        to={ticketPath(ticket, props.params)}
      >
        <span className="text-sm font-medium break-words">{ticket.title}</span>
        <span className="text-muted-foreground text-xs">
          {ticketMeta(ticket)}
        </span>
      </Link>
    </li>
  );
};

const TicketBoard = (props: {
  query: JiraTicketQuery;
  params: URLSearchParams;
}) => {
  const { query, params } = props;
  const tickets = useJiraResource<JiraTickets>(
    ["kanban", jiraQueryParams({ ...query, startAt: 0 }).toString()],
    (signal) => fetchAllTickets(query, signal)
  );
  // Boards lay out their own columns; other views get one column per status.
  const board = query.scope === "board" ? query.board : undefined;
  const columns = useJiraResource<JiraBoardColumn[]>(
    ["columns", board],
    (signal) =>
      board === undefined
        ? Promise.resolve([])
        : fetchJiraBoardColumns(board, signal)
  );
  const { data } = tickets;
  const ready = data && !columns.loading;
  return (
    <>
      {(tickets.loading || columns.loading) && (
        <Loading>Loading board…</Loading>
      )}
      {tickets.error && <Failure>{tickets.error}</Failure>}
      {columns.error && (
        <Note warn>
          The board’s columns could not be loaded, so tickets are grouped by
          status: {columns.error}
        </Note>
      )}
      {data && data.total > data.tickets.length && (
        <Note warn>
          Showing the first {data.tickets.length} of {data.total} tickets.
          Narrow the filters to see the rest.
        </Note>
      )}
      {ready && data.tickets.length === 0 && !columns.data?.length && (
        <NoTickets />
      )}
      {ready && (data.tickets.length > 0 || !!columns.data?.length) && (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {jiraKanban(data.tickets, columns.data).map((column) => (
            <section
              key={column.name}
              aria-label={column.name}
              className="bg-muted/40 flex w-72 shrink-0 flex-col gap-2 rounded-xl border p-2"
            >
              <h2 className="flex items-baseline gap-2 px-1 text-sm font-semibold">
                {column.name}
                <span className="text-muted-foreground font-normal">
                  {column.tickets.length}
                </span>
              </h2>
              {column.tickets.length > 0 ? (
                <ul className="flex flex-col gap-2">
                  {column.tickets.map((ticket) => (
                    <KanbanCard
                      key={ticket.key}
                      ticket={ticket}
                      params={params}
                    />
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground px-1 pb-1 text-xs">
                  No tickets
                </p>
              )}
            </section>
          ))}
        </div>
      )}
    </>
  );
};

export const JiraPage = () => {
  const [params, setParams] = useSearchParams();
  const query = parseJiraQuery(params) ?? JIRA_DEFAULT_QUERY;
  const layout: JiraLayout =
    params.get("layout") === "board" ? "board" : "list";
  const { search } = query;
  const [input, setInput] = useState(search);
  useEffect(() => setInput(search), [search]);
  const catalog = useJiraResource<JiraCatalog>(["catalog"], fetchJiraCatalog);
  const queryClient = useQueryClient();
  const busy = useIsFetching({ queryKey: ["jira"] }) > 0;
  // Every change but paging starts again from the first page.
  const change = (patch: Partial<JiraTicketQuery>) =>
    setParams(pageParams({ ...query, startAt: 0, ...patch }, layout));
  const board =
    query.scope === "board"
      ? catalog.data?.boards.find((b) => b.id === query.board)
      : undefined;
  const customized =
    jiraQueryParams({ ...query, search: "", startAt: 0 }).size > 0;
  const projectOptions: ChoiceOption[] = [
    { label: "All projects", value: "" },
    ...(query.project &&
    !catalog.data?.projects.some((p) => p.key === query.project)
      ? [{ label: query.project, value: query.project }]
      : []),
    ...(catalog.data?.projects ?? []).map((p) => ({
      label: `${p.name} (${p.key})`,
      value: p.key,
    })),
  ];
  const where = viewPhrase(query, catalog.data);
  return (
    <Page>
      <PageHeader
        title="Tickets"
        description={search ? `${where} matching “${search}”.` : `${where}.`}
        actions={
          <>
            <LayoutToggle
              value={layout}
              onChange={(next) =>
                setParams(pageParams({ ...query, startAt: 0 }, next))
              }
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                void queryClient.invalidateQueries({ queryKey: ["jira"] })
              }
            >
              <RefreshCwIcon className={busy ? "animate-spin" : ""} /> Refresh
            </Button>
          </>
        }
      />
      <JiraGate>
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="jira-view">View</Label>
            <Choice
              id="jira-view"
              size="default"
              className="w-56"
              value={viewValue(query)}
              options={viewOptions(query, catalog.data)}
              onChange={(value) => change(viewQuery(value))}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="jira-project">Project</Label>
            <Choice
              id="jira-project"
              size="default"
              className="w-48"
              value={query.project ?? ""}
              options={projectOptions}
              onChange={(project) => change({ project: project || undefined })}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="jira-status">Status</Label>
            <Choice
              id="jira-status"
              size="default"
              className="w-36"
              value={query.status}
              options={STATUS_OPTIONS}
              onChange={(status) =>
                change({ status: status as JiraStatusFilter })
              }
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="jira-sort">Sort</Label>
            <Choice
              id="jira-sort"
              size="default"
              className="w-44"
              value={query.sort}
              options={SORT_OPTIONS}
              onChange={(sort) => change({ sort: sort as JiraSort })}
            />
          </div>
          {query.scope === "board" && (!board || board.type === "scrum") && (
            <Label className="h-9 font-normal">
              <Checkbox
                checked={!!query.sprint}
                onCheckedChange={(checked) =>
                  change({ sprint: checked === true })
                }
              />
              Active sprint only
            </Label>
          )}
        </div>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            change({ search: input.trim() });
          }}
        >
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor="jira-search">Search tickets</Label>
            <Input
              id="jira-search"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={500}
              placeholder="Text in this view, or a ticket key such as APP-123"
            />
          </div>
          <Button type="submit">
            <SearchIcon /> Search
          </Button>
          {(search || customized) && (
            <Button
              type="button"
              variant="outline"
              onClick={() => setParams(pageParams({}, layout))}
            >
              Reset
            </Button>
          )}
        </form>
        {catalog.error && (
          <Note warn>
            Boards, filters and projects could not be loaded: {catalog.error}
          </Note>
        )}
        {layout === "board" ? (
          <TicketBoard query={query} params={params} />
        ) : (
          <TicketList
            query={query}
            params={params}
            change={change}
            title={search ? "Results" : listTitle(query, catalog.data)}
          />
        )}
      </JiraGate>
    </Page>
  );
};

export const JiraTicketPage = () => {
  const { key = "" } = useParams({ strict: false });
  return <TicketDetails key={key} ticketKey={key} />;
};

const TicketDetails = ({ ticketKey }: { ticketKey: string }) => {
  const { snapshot, newTask } = useDash();
  const [params] = useSearchParams();
  const { data, error, busy, loading, refresh } = useJiraResource<JiraTicket>(
    ["ticket", ticketKey],
    (signal) => fetchJiraTicket(ticketKey, signal)
  );
  const source: JiraTaskSource | undefined = data
    ? {
        description: data.description,
        instanceUrl: data.instanceUrl,
        key: data.key,
        title: data.title,
      }
    : undefined;
  const { data: links } = useTicketLinks(data);
  const projectName = (id: string) =>
    snapshot?.projects.find((v) => v.project.id === id)?.project.name ?? id;
  const linked = links?.tasks ?? [];
  const open = linked.find((t) => !t.archived);
  const firstTask = open ? taskPath(open.projectId, open.id) : undefined;
  const tooLarge =
    source &&
    (jiraTaskPrompt(source).length > 100_000 || source.title.length > 1000);
  return (
    <Page>
      <Link
        to={`/jira${params.size ? `?${params}` : ""}`}
        className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-sm"
      >
        <ArrowLeftIcon className="size-4" /> Tickets
      </Link>
      <PageHeader
        title={data ? `${data.key}: ${data.title}` : ticketKey}
        description={
          data
            ? `${data.project} · ${data.type} · ${data.status}`
            : "Ticket details"
        }
        actions={
          <>
            {data && (
              <Button asChild variant="outline" size="sm">
                <a href={data.url} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon /> Open in Jira
                </a>
              </Button>
            )}
            {firstTask && (
              <Button asChild size="sm">
                <Link to={firstTask}>
                  <ArrowRightIcon /> Open task
                </Link>
              </Button>
            )}
            {source && (
              <Button
                size="sm"
                variant={firstTask ? "outline" : "default"}
                disabled={!!tooLarge}
                onClick={() => newTask(undefined, { jira: source })}
              >
                <PlusIcon /> {firstTask ? "Another task" : "Create task"}
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={refresh}
            >
              <RefreshCwIcon className={busy ? "animate-spin" : ""} /> Refresh
            </Button>
          </>
        }
      />
      <JiraGate>
        {loading && (
          <p role="status" className="text-muted-foreground text-sm">
            Loading ticket…
          </p>
        )}
        {error && (
          <div role="alert">
            <Note error>{error}</Note>
          </div>
        )}
        {tooLarge && (
          <Note warn>
            This ticket exceeds the task size limit. Shorten its description in
            Jira before creating a task.
          </Note>
        )}
        {data && (
          <>
            {links?.id !== undefined && (
              <ProvenanceBreadcrumb type="ticket" id={String(links.id)} />
            )}
            {linked.length > 0 && (
              <Section title="Tasks from this ticket" hint={linked.length}>
                <ul className="divide-y">
                  {linked.map((task) => (
                    <li
                      key={task.id}
                      className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm"
                    >
                      <Link
                        className="min-w-0 flex-1 truncate hover:underline"
                        to={taskPath(task.projectId, task.id)}
                      >
                        {projectName(task.projectId)} · {task.title}
                      </Link>
                      <span className="text-muted-foreground text-xs">
                        {task.archived ? "archived" : task.state}
                      </span>
                      {task.pullRequests.map((pull) => (
                        <PullRequestBadge
                          key={`${pull.variant}-${pull.url}`}
                          pull={pull}
                          {...(task.pullRequests.length > 1
                            ? { prefix: `variant ${pull.variant}` }
                            : {})}
                        />
                      ))}
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            <Section title="Details">
              <dl className="[&_dt]:text-muted-foreground grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-4 text-sm">
                <dt>Assignee</dt>
                <dd>{data.assignee ?? "Unassigned"}</dd>
                <dt>Reporter</dt>
                <dd>{data.reporter ?? "—"}</dd>
                <dt>Priority</dt>
                <dd>{data.priority ?? "—"}</dd>
                <dt>Labels</dt>
                <dd className="break-words">{data.labels.join(", ") || "—"}</dd>
                <dt>Updated</dt>
                <dd>
                  <When at={data.updatedAt} />
                </dd>
              </dl>
            </Section>
            <Section title="Description">
              {data.description ? (
                <MarkdownBody className="px-4 py-4">
                  {data.description}
                </MarkdownBody>
              ) : (
                <p className="px-4 py-4 text-sm">No description provided.</p>
              )}
            </Section>
          </>
        )}
      </JiraGate>
    </Page>
  );
};
