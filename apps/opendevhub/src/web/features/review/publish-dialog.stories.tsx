import { fn } from "storybook/test";

import preview from "../../../../.storybook/preview";
import { publishInfo } from "../../mocks/fixtures";
import { failing } from "../../mocks/handlers";
import { mockApi } from "../../mocks/story";
import { PublishDialog } from "./publish-dialog";

const meta = preview.meta({
  args: {
    baseName: "main",
    directory: "/workspaces/.worktrees/acme-web/rate-limit",
    info: publishInfo,
    loadInfo: fn(() => Promise.resolve(publishInfo)),
    onClose: fn(),
    onPublished: fn(),
    projectId: "acme-web",
  },
  component: PublishDialog,
  title: "Components/PublishDialog",
});

/** Just pushes the branch by default; no title needed. */
export const Default = meta.story();

/** Opening a PR asks for a title; the sparkles button asks the agent for one. */
export const OpensPr = meta.story({
  args: { info: { ...publishInfo, strategy: "branch" } },
});

export const ChecksNotPassing = meta.story({
  args: { checksWarning: "1 of 3 checks failed on this commit" },
});

/** Already published: pushing updates the existing pull request. */
export const UpdatesExistingPr = meta.story({
  args: {
    info: { ...publishInfo, pr: "https://git.acme.dev/acme/web/pulls/42" },
  },
});

export const SuggestionFails = meta.story({
  args: { info: { ...publishInfo, strategy: "branch" } },
  beforeEach: mockApi(
    {},
    failing("post", "/api/projects/:id/publish/suggest", "model unavailable")
  ),
});
