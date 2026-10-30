import { expect, userEvent, waitFor, within } from "storybook/test";

import preview from "../../../../.storybook/preview";
import { App } from "../../app";

const PANEL_KEY = "opendevhub.conversation.panel";

const meta = preview.meta({
  // Each story starts with the side panels closed, whatever an earlier one opened.
  beforeEach: () => {
    localStorage.removeItem(PANEL_KEY);
    return () => localStorage.removeItem(PANEL_KEY);
  },
  component: App,
  parameters: { route: "/chat/acme-web/c_dark" },
  title: "Pages/Chat/View",
});

/** A chat in a worktree, full-width: the transcript and the composer, with Make task in its header and the side panels on the right. */
export const Conversation = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: /make task/iu })
    ).toBeEnabled();
    await expect(
      canvas.getByRole("button", { name: /changes/iu })
    ).toBeEnabled();
    const transcript = canvas.getByRole("region", {
      name: "Conversation transcript",
    });
    await canvas.findByText(
      "Registered the limiter on POST /login. Running the rate-limit tests next."
    );
    await expect(
      canvas.getByText(
        "Read the rate limiter and explain how it counts requests"
      )
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(transcript.scrollHeight).toBeGreaterThan(transcript.clientHeight)
    );
    await waitFor(() =>
      expect(
        transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
      ).toBeLessThanOrEqual(2)
    );
    transcript.scrollTop = 0;
    // The first prompt opens the transcript; the newest is near the composer.
    await expect(
      await canvas.findByText(
        "Read the rate limiter and explain how it counts requests"
      )
    ).toBeVisible();
    await expect(canvas.getByText("6 tool calls")).toBeInTheDocument();
    transcript.scrollTop = transcript.scrollHeight;
    await expect(canvas.queryByText("Cost")).not.toBeInTheDocument();
    await expect(
      canvas.getByRole("combobox", { name: "Message the agent" })
    ).toBeVisible();
  },
});

/**
 * Restoring the checkpoint above a message hides it and what followed, fills the composer with it, and shows the
 * bar with Redo; Redo brings everything back.
 */
export const RestoreCheckpoint = meta.story({
  parameters: { route: "/chat/acme-web/c_idle" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const prompt = "Also register the limiter on the login route";
    const transcript = within(
      await canvas.findByRole("region", { name: "Conversation transcript" })
    );
    await transcript.findByText(prompt);
    const checkpoints = transcript.getAllByRole("button", {
      name: "Restore checkpoint",
    });
    await userEvent.click(checkpoints.at(-1) as HTMLElement);
    const bar = within(
      await canvas.findByRole("region", { name: "Restored checkpoint" })
    );
    await expect(bar.getByText(/2 messages hidden/iu)).toBeVisible();
    await expect(bar.getByText("2 files changed back")).toBeVisible();
    await expect(
      canvas.getByRole("combobox", { name: "Message the agent" })
    ).toHaveValue(prompt);
    await userEvent.click(bar.getByRole("button", { name: "Redo" }));
    await waitFor(() =>
      expect(
        canvas.queryByRole("region", { name: "Restored checkpoint" })
      ).not.toBeInTheDocument()
    );
    await expect(await transcript.findByText(prompt)).toBeInTheDocument();
  },
});

/** While the agent works, the checkpoints are turned off. */
export const CheckpointsWhileRunning = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(
      "Read the rate limiter and explain how it counts requests"
    );
    for (const button of canvas.getAllByRole("button", {
      name: "Restore checkpoint",
    })) {
      await expect(button).toBeDisabled();
    }
  },
});

/** The usage button opens a popover with the conversation's cost, tokens and context. */
export const Usage = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: /^usage/iu })
    );
    const popover = within(canvasElement.ownerDocument.body);
    await expect(await popover.findByText("Cost")).toBeVisible();
    await expect(
      popover.getByRole("meter", { name: "Context window used" })
    ).toBeInTheDocument();
  },
});

/** The agent asks a question: its card sits right above the composer. */
export const Question = meta.story({
  parameters: { route: "/chat/acme-web/c_form" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Which store should back the limiter?")
    ).toBeVisible();
  },
});

/** Opening, switching and closing the side panels from the sidebar's rail. */
export const SidePanels = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rail = within(
      await canvas.findByRole("list", { name: "Side panels" })
    );
    await userEvent.click(rail.getByRole("button", { name: "Turns" }));
    await expect(
      await canvas.findByRole("complementary", { name: "Turns" })
    ).toBeVisible();
    await userEvent.click(rail.getByRole("button", { name: "Changes" }));
    await expect(
      await canvas.findByRole("complementary", { name: "Changes" })
    ).toBeVisible();
    await userEvent.click(rail.getByRole("button", { name: "Subagents" }));
    await expect(
      await canvas.findByText("Find where requests are counted")
    ).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Close Subagents" })
    );
    await expect(
      canvas.queryByRole("complementary", { name: "Subagents" })
    ).not.toBeInTheDocument();
    await userEvent.click(rail.getByRole("button", { name: "Terminal" }));
    await expect(
      await canvas.findByRole("complementary", { name: "Terminal" })
    ).toBeVisible();
    await expect(
      await canvas.findByRole("combobox", { name: "Terminal shell" })
    ).toHaveTextContent("bash");
    await expect(await canvas.findByText("Connected")).toBeVisible();
    await userEvent.click(
      canvas.getByRole("button", { name: "Close Terminal" })
    );
    await expect(
      canvas.queryByRole("complementary", { name: "Terminal" })
    ).not.toBeInTheDocument();
  },
});

/** The terminal fills the right sidebar, beside the transcript and composer. */
export const Terminal = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Terminal" })
    );
    await expect(
      await canvas.findByRole("complementary", { name: "Terminal" })
    ).toBeVisible();
    await expect(await canvas.findByText("Connected")).toBeVisible();
  },
});

/** On a phone the terminal opens in the same sheet as the other panels. */
export const MobileTerminal = meta.story({
  globals: { viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Terminal" })
    );
    const body = within(canvasElement.ownerDocument.body);
    await expect(
      await body.findByRole("dialog", { name: "Terminal" })
    ).toBeVisible();
    await expect(await body.findByText("Connected")).toBeVisible();
  },
});

/** On a phone the Turns panel opens as a sheet over the transcript. */
export const MobileSheet = meta.story({
  globals: { viewport: { isRotated: false, value: "mobile1" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Turns" }));
    const body = within(canvasElement.ownerDocument.body);
    await expect(await body.findByRole("dialog")).toBeVisible();
  },
});

/** The new worktree is still being set up: the view shows how far it got instead of a conversation. */
export const Starting = meta.story({
  parameters: { route: "/chat/acme-web/c_new" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Starting the chat")).toBeVisible();
    await expect(canvas.getByText("Creating the worktree…")).toBeVisible();
  },
});

/** A chat in the main checkout: Make task is off, since only a chat in a worktree can become a task. */
export const MainCheckout = meta.story({
  parameters: { route: "/chat/acme-web/c_idle" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("button", { name: /make task/iu })
    ).toBeDisabled();
  },
});

/** A chat a task adopted: its old link opens the task with variant 1 selected. */
export const Adopted = meta.story({
  parameters: { route: "/chat/billing-api/c_round" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        name: "Fix invoice rounding for JPY",
      })
    ).toBeVisible();
  },
});

/** An old chat link keyed by a task opens the task. */
export const OldTaskLink = meta.story({
  parameters: { route: "/chat/acme-web/tsk_rate" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", {
        name: "Add burst limit to the login rate limiter",
      })
    ).toBeVisible();
  },
});

/** A chat that doesn't exist: the page says so and offers a new chat. */
export const NotFound = meta.story({
  parameters: { route: "/chat/acme-web/missing" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("Chat not found")).toBeVisible();
  },
});

/** Chat in the sidebar always opens an empty start composer, even from a chat. */
export const NewChatFromSidebar = meta.story({
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("link", { name: "Chat" }));
    await expect(
      await canvas.findByRole("heading", {
        name: /what shall we build/iu,
      })
    ).toBeVisible();
    await expect(
      canvas.getByRole("combobox", { name: "Message the agent" })
    ).toHaveValue("");
  },
});
