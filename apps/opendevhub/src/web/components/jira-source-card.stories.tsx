import preview from "../../../.storybook/preview";
import { jiraTicket } from "../mocks/fixtures";
import { JiraSourceCard } from "./jira-source-card";

const ticket = jiraTicket("ACME-118");

const meta = preview.meta({
  args: {
    source: {
      description: ticket.description,
      instanceUrl: ticket.instanceUrl,
      key: ticket.key,
      title: ticket.title,
    },
  },
  component: JiraSourceCard,
  parameters: { layout: "padded" },
  title: "Components/JiraSourceCard",
});

export const Default = meta.story();
