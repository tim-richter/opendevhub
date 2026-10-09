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

/** Title and description are suggested in the background. */
export const Default = meta.story();

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
  beforeEach: mockApi(
    {},
    failing("post", "/api/projects/:id/publish/suggest", "model unavailable")
  ),
});
