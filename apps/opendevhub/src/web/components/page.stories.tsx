import { PlusIcon } from "lucide-react";

import preview from "../../../.storybook/preview";
import { Chip, Empty, Note, Page, PageHeader, Section } from "./page";
import { Button } from "./ui/button";

const meta = preview.meta({
  component: Page,
  parameters: { layout: "padded" },
  title: "Components/Page",
});

/** The building blocks every page is laid out with. */
export const Layout = meta.story({
  render: () => (
    <Page>
      <PageHeader
        title="Cleanup"
        description="Merged branches, stale sessions, unused containers and images."
        actions={
          <Button>
            <PlusIcon /> New task
          </Button>
        }
      />
      <Section title="Branches & worktrees" hint="merged into their base">
        <ul className="divide-y">
          <li className="flex items-center gap-2 px-4 py-2 text-sm">
            feat/old-banner <Chip>merged into main</Chip>
          </li>
          <li className="flex items-center gap-2 px-4 py-2 text-sm">
            spike/graphql <Chip>upstream branch is gone</Chip>
          </li>
        </ul>
      </Section>
      <Section title="Waiting on you" hint="Answer here" attention>
        <p className="px-4 py-3 text-sm">An attention section.</p>
      </Section>
      <Note>Start the project to create worktrees.</Note>
      <Note warn>using local refs: fetch failed</Note>
      <Empty title="No sessions">
        <p className="text-muted-foreground text-sm">
          Start a project and open opencode to create one.
        </p>
      </Empty>
    </Page>
  ),
});
