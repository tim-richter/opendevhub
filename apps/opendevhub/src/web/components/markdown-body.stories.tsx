import preview from "../../../.storybook/preview";
import { forgejoDetails, jiraTicket } from "../mocks/fixtures";
import { MarkdownBody } from "./markdown-body";

const meta = preview.meta({
  args: { children: forgejoDetails.body },
  component: MarkdownBody,
  parameters: { layout: "padded" },
  title: "Components/MarkdownBody",
});

export const PullRequestBody = meta.story();

export const JiraDescription = meta.story({
  args: { children: jiraTicket("ACME-118").description },
});

export const Kitchen = meta.story({
  args: {
    children: [
      "# Heading",
      "Some **bold**, _italic_, `code` and a [link](https://example.com).",
      "| Column | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |",
      "```ts\nconst limit = createLimiter(100);\n```",
      "> A quote",
      "- [x] done\n- [ ] todo",
    ].join("\n\n"),
  },
});
