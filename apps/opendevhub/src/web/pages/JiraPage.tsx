import { ArrowLeftIcon, ExternalLinkIcon, PlusIcon, RefreshCwIcon, SearchIcon, TicketIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { jiraTaskPrompt, type JiraTaskSource, type JiraTicket, type JiraTickets } from "../../shared/jira";
import { fetchJiraTicket, fetchJiraTickets } from "../api";
import { Chip, Empty, Note, Page, PageHeader, Section } from "../components/Page";
import { useDash } from "../DashboardContext";
import { taskPath } from "../tasks";

function useJiraResource<T>(load: (signal: AbortSignal) => Promise<T>) {
  const { jira } = useDash();
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setData(undefined);
    setError(undefined);
    if (!jira?.enabled) { setBusy(false); return; }
    const controller = new AbortController();
    setBusy(true);
    void load(controller.signal).then(
      (value) => { if (!controller.signal.aborted) setData(value); },
      (err: unknown) => { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err)); },
    ).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [jira, load, revision]);
  return { data, error, busy, refresh: () => setRevision((value) => value + 1) };
}

function JiraGate({ children }: { children: ReactNode }) {
  const { jira, jiraError } = useDash();
  if (!jira && !jiraError) return <p role="status" className="text-sm text-muted-foreground">Loading Jira settings…</p>;
  if (!jira?.enabled) return <Empty title="Jira is disabled">
    {jiraError && <Note warn>{jiraError}</Note>}
    <p className="text-sm text-muted-foreground">Connect your Jira instance to browse tickets and create tasks.</p>
    <Button asChild variant="outline"><Link to="/settings">Open settings</Link></Button>
  </Empty>;
  return children;
}

export function JiraPage() {
  const [params, setParams] = useSearchParams();
  const search = params.get("search") ?? "";
  const page = Number(params.get("startAt") ?? "0");
  const startAt = Number.isSafeInteger(page) && page >= 0 ? page : 0;
  const [input, setInput] = useState(search);
  useEffect(() => setInput(search), [search]);
  const load = useCallback((signal: AbortSignal) => fetchJiraTickets(search, startAt, signal), [search, startAt]);
  const { data, error, busy, refresh } = useJiraResource<JiraTickets>(load);
  const change = (term: string, offset = 0) => setParams({ ...(term ? { search: term } : {}), ...(offset ? { startAt: String(offset) } : {}) });
  return <Page>
    <PageHeader title="Jira" description={search ? `Tickets matching “${search}”.` : "Tickets assigned to you, most recently updated first."}
      actions={<Button variant="outline" size="sm" disabled={busy} onClick={refresh}><RefreshCwIcon className={busy ? "animate-spin" : ""} /> Refresh</Button>} />
    <JiraGate>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); change(input.trim()); }}>
        <div className="flex min-w-56 flex-1 flex-col gap-1.5">
          <Label htmlFor="jira-search">Search tickets</Label>
          <Input id="jira-search" value={input} onChange={(e) => setInput(e.target.value)} maxLength={500} placeholder="Ticket key or text, e.g. APP-123" />
        </div>
        <Button type="submit"><SearchIcon /> Search</Button>
        {search && <Button type="button" variant="outline" onClick={() => change("")}>Assigned to me</Button>}
      </form>
      {busy && <p role="status" className="text-sm text-muted-foreground">Loading tickets…</p>}
      {error && <div role="alert"><Note warn>{error}</Note></div>}
      {data?.tickets.length === 0 && <Empty title="No tickets"><p className="text-sm text-muted-foreground">{search ? "No tickets match this search in projects accessible to your token." : "No tickets are assigned to you in projects accessible to your token."}</p></Empty>}
      {!!data?.tickets.length && <Section title="Tickets" hint={`${startAt + 1}–${startAt + data.tickets.length} of ${data.total}`}>
        <ul className="divide-y">
          {data.tickets.map((ticket) => <li key={ticket.key}>
            <Link className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring"
              to={`/jira/${encodeURIComponent(ticket.key)}${params.size ? `?${params}` : ""}`}>
              <TicketIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="font-medium break-words">{ticket.title}</p>
                <p className="text-sm text-muted-foreground">{ticket.key} · {ticket.type}{ticket.assignee ? ` · ${ticket.assignee}` : ""}</p>
              </div>
              <Chip>{ticket.status}</Chip>
            </Link>
          </li>)}
        </ul>
      </Section>}
      {data && <div className="flex gap-2">
        {startAt > 0 && <Button variant="outline" onClick={() => change(search)}>First page</Button>}
        {data.nextStartAt !== undefined && <Button variant="outline" onClick={() => change(search, data.nextStartAt)}>Next page</Button>}
      </div>}
    </JiraGate>
  </Page>;
}

export function JiraTicketPage() {
  const { key = "" } = useParams();
  return <TicketDetails key={key} ticketKey={key} />;
}

function TicketDetails({ ticketKey }: { ticketKey: string }) {
  const { snapshot, newTask } = useDash();
  const [params] = useSearchParams();
  const load = useCallback((signal: AbortSignal) => fetchJiraTicket(ticketKey, signal), [ticketKey]);
  const { data, error, busy, refresh } = useJiraResource<JiraTicket>(load);
  const source: JiraTaskSource | undefined = data ? { key: data.key, instanceUrl: data.instanceUrl, title: data.title, description: data.description } : undefined;
  const linked = new Map<string, { projectId: string; title: string }>();
  if (source) for (const view of snapshot?.projects ?? []) for (const session of view.sessions) {
    const task = session.task;
    if (task?.jira?.key === source.key && task.jira.instanceUrl === source.instanceUrl && !task.discarded) {
      linked.set(taskPath(view.project.id, task.task), { projectId: view.project.name, title: task.title });
    }
  }
  const tooLarge = source && (jiraTaskPrompt(source).length > 100_000 || source.title.length > 1000);
  return <Page>
    <Link to={`/jira${params.size ? `?${params}` : ""}`} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeftIcon className="size-4" /> Tickets</Link>
    <PageHeader title={data ? `${data.key}: ${data.title}` : ticketKey} description={data ? `${data.project} · ${data.type} · ${data.status}` : "Ticket details"}
      actions={<>
        {data && <Button asChild variant="outline" size="sm"><a href={data.url} target="_blank" rel="noreferrer"><ExternalLinkIcon /> Open in Jira</a></Button>}
        {source && <Button size="sm" disabled={!!tooLarge} onClick={() => newTask(undefined, { jira: source })}><PlusIcon /> Create task</Button>}
        <Button variant="outline" size="sm" disabled={busy} onClick={refresh}><RefreshCwIcon className={busy ? "animate-spin" : ""} /> Refresh</Button>
      </>} />
    <JiraGate>
      {busy && <p role="status" className="text-sm text-muted-foreground">Loading ticket…</p>}
      {error && <div role="alert"><Note warn>{error}</Note></div>}
      {tooLarge && <Note warn>This ticket exceeds the task size limit. Shorten its description in Jira before creating a task.</Note>}
      {data && <>
        <Section title="Details"><dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 px-4 py-4 text-sm [&_dt]:text-muted-foreground">
          <dt>Assignee</dt><dd>{data.assignee ?? "Unassigned"}</dd>
          <dt>Reporter</dt><dd>{data.reporter ?? "—"}</dd>
          <dt>Priority</dt><dd>{data.priority ?? "—"}</dd>
          <dt>Labels</dt><dd className="break-words">{data.labels.join(", ") || "—"}</dd>
          <dt>Updated</dt><dd>{data.updatedAt}</dd>
        </dl></Section>
        <Section title="Description"><div className="whitespace-pre-wrap break-words px-4 py-4 text-sm">{data.description || "No description provided."}</div></Section>
        {linked.size > 0 && <Section title="Tasks created from this ticket"><ul className="divide-y">
          {[...linked].map(([url, task]) => <li key={url}><Link className="block px-4 py-3 text-sm hover:bg-muted/50" to={url}>{task.projectId} · {task.title}</Link></li>)}
        </ul></Section>}
      </>}
    </JiraGate>
  </Page>;
}
