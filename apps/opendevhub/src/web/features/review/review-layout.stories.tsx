import { DropdownMenuItem } from "@opendevhub/ui/dropdown-menu";
import { GitBranchPlusIcon, GitPullRequestArrowIcon } from "lucide-react";
import { fn } from "storybook/test";

import preview from "../../../../.storybook/preview";
import type { ReviewData, ReviewFile } from "../../../shared/types";
import { RATE_LIMIT_PATCH } from "../../mocks/fixtures";
import { FileGroups } from "./file-groups";
import { nextStep } from "./next-step";
import { ReviewSidebar } from "./review-sidebar";
import { ReviewToolbar } from "./review-toolbar";
import { ChangeSections } from "./stage-view";
import type { Stage } from "./stage-view";
import { StepPanel } from "./step-panel";

const file = (name: string): ReviewFile => ({
  additions: 4,
  deletions: 1,
  file: name,
  patch: RATE_LIMIT_PATCH,
  status: "modified",
});

const data: ReviewData = {
  ahead: 2,
  behind: 0,
  base: { name: "main", source: "default" },
  branch: "rate-limit",
  directory: "/work",
  dirty: true,
  files: [file("src/server/rate-limit.ts")],
  mode: "working",
  pushed: false,
  workspace: { branch: "main", clean: true },
};

const stage = (kept: number): Stage => ({
  busy: false,
  change: fn(),
  commit: fn(() => Promise.resolve()),
  data: {
    directory: "/work",
    staged: kept ? [file("src/server/limits.ts")] : [],
    unstaged: [file("src/server/rate-limit.ts")],
  },
  error: undefined,
  kept,
  left: 1,
});

const Layout = (props: { kept: number; review: ReviewData }) => {
  const { review } = props;
  const s = stage(props.kept);
  const step = nextStep(review, { baseName: "main", hasPullRequest: false });
  return (
    <div
      className="flex flex-col gap-4"
      style={{ "--review-gutter": "1rem" } as React.CSSProperties}
    >
      <ReviewToolbar
        barRef={{ current: null }}
        data={review}
        hasError={false}
        base="main"
        loading={false}
        view={{ fullFile: false, hideFiles: false, split: false }}
        onView={fn()}
        onMode={fn()}
        onPickBase={fn()}
        onRefresh={fn()}
        tools={null}
        branchItems={
          <DropdownMenuItem onSelect={fn()}>
            <GitBranchPlusIcon /> New branch…
          </DropdownMenuItem>
        }
      />
      <div className="grid items-start gap-4 md:grid-cols-[minmax(16rem,20rem)_minmax(0,1fr)]">
        <ReviewSidebar
          files={[]}
          list={
            <FileGroups
              unstaged={s.data?.unstaged ?? []}
              staged={s.data?.staged ?? []}
              selection={{ file: "src/server/rate-limit.ts", staged: false }}
              disabled={false}
              onSelect={fn()}
              change={fn()}
            />
          }
          showFiles
          onSelect={fn()}
        >
          <StepPanel
            step={step}
            showingUncommitted
            kept={s.kept}
            left={s.left}
            committing={false}
            comments={2}
            primary={
              step.kind === "publish"
                ? {
                    icon: <GitPullRequestArrowIcon />,
                    label: "Publish…",
                    run: fn(),
                  }
                : undefined
            }
            more={null}
            onCommit={fn(() => Promise.resolve())}
            onKeepAll={fn()}
            onSuggest={fn(() => Promise.resolve("Rate limit requests per key"))}
            onShowUncommitted={fn()}
            onComments={fn()}
            onBase={
              review.dirty && review.branch === "main" ? "main" : undefined
            }
            onNewBranch={fn()}
          />
        </ReviewSidebar>
        <ChangeSections
          stage={s}
          selection={{ file: "src/server/rate-limit.ts", staged: false }}
          diffProps={{
            comments: [],
            onAdd: fn(),
            onCancel: fn(),
            onDelete: fn(),
            placeholder: "Comment for the agent…",
            view: { fullFile: false, hideFiles: false, split: false },
          }}
        />
      </div>
    </div>
  );
};

const meta = preview.meta({
  component: Layout,
  parameters: { layout: "padded" },
  title: "Pages/ReviewLayout",
});

/** Nothing kept yet: the diff asks for decisions, the panel waits for them. */
export const Deciding = meta.story({ args: { kept: 0, review: data } });

/** Something kept: the commit button says how much it will commit. */
export const ReadyToCommit = meta.story({ args: { kept: 1, review: data } });

/** Committed: the panel moves on to publishing. */
export const ReadyToPublish = meta.story({
  args: { kept: 0, review: { ...data, dirty: false, files: [] } },
});

/** Changes on the base itself: the commit form offers a branch before they land on main. */
export const OnTheBase = meta.story({
  args: { kept: 1, review: { ...data, ahead: 0, branch: "main" } },
});
