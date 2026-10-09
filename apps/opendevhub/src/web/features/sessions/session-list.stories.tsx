import preview from "../../../../.storybook/preview";
import { allSessions } from "../../derive";
import { snapshot, webProject } from "../../mocks/fixtures";
import { SessionList } from "./session-list";

const entries = allSessions(snapshot);

const meta = preview.meta({
  args: { entries },
  component: SessionList,
  parameters: { layout: "padded" },
  title: "Components/SessionList",
});

/** Every session, waiting ones first, with their pending permission or question inline. */
export const AcrossProjects = meta.story({ args: { showProject: true } });

/** As a checkout's own page shows it. */
export const OneCheckout = meta.story({
  args: {
    entries: entries.filter(
      ({ view, session }) =>
        view === webProject && session.directory === "/workspaces/acme-web"
    ),
    hideWorktree: true,
  },
});

export const Highlighted = meta.story({
  args: { highlight: "ses_idle01", showProject: true },
});
