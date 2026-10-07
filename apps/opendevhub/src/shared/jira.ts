export type { IntegrationSettings as JiraSettings, IntegrationSettingsInput as JiraSettingsInput } from "./integrations";

export interface JiraTicketSummary {
  key: string;
  title: string;
  url: string;
  status: string;
  type: string;
  priority?: string;
  assignee?: string;
  updatedAt: string;
}

export interface JiraTicket extends JiraTicketSummary {
  instanceUrl: string;
  description: string;
  project: string;
  reporter?: string;
  labels: string[];
  createdAt: string;
}

export interface JiraTickets {
  tickets: JiraTicketSummary[];
  total: number;
  nextStartAt?: number;
}

/** A durable snapshot of the ticket used to create a task, stored in session metadata. */
export interface JiraTaskSource {
  key: string;
  instanceUrl: string;
  title: string;
  description: string;
}

export const JIRA_KEY = /^[A-Z][A-Z0-9_]*-[1-9]\d*$/;

export function jiraTicketUrl(ticket: Pick<JiraTaskSource, "instanceUrl" | "key">): string {
  return `${ticket.instanceUrl}/browse/${encodeURIComponent(ticket.key)}`;
}

export function jiraTaskPrompt(ticket: JiraTaskSource): string {
  return `Implement ${ticket.key}: ${ticket.title}\n\nTicket: ${jiraTicketUrl(ticket)}\n\n${ticket.description || "No description provided."}`;
}
