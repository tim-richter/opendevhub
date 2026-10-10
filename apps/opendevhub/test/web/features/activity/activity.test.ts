import { describe, expect, it } from "vitest";

import { EVENT_VERBS } from "../../../../src/shared/activity";
import type { ActivityEvent } from "../../../../src/shared/activity";
import {
  EVENT_TEXT,
  eventLink,
  eventText,
  filterKey,
  mergeEvents,
  originLabel,
  pullLabel,
  sessionOrigin,
} from "../../../../src/web/features/activity/activity";

const event = (patch: Partial<ActivityEvent>): ActivityEvent => ({
  actor: { type: "user" },
  at: 1,
  id: 1,
  object: { id: "1", type: "task" },
  projectId: "demo",
  verb: "task.started",
  ...patch,
});

describe("event renderers", () => {
  it("has a renderer for every recorded verb", () => {
    const missing = EVENT_VERBS.filter(
      (verb) => typeof EVENT_TEXT[verb] !== "function"
    );
    expect(missing).toStrictEqual([]);
    expect(Object.keys(EVENT_TEXT).toSorted()).toStrictEqual(
      [...EVENT_VERBS].toSorted()
    );
    for (const verb of EVENT_VERBS) {
      expect(eventText(event({ verb })).length).toBeGreaterThan(0);
    }
  });

  it("reads an adopted worktree as found outside opendevhub, by opendevhub", () => {
    expect(
      eventText(
        event({
          actor: { type: "system" },
          data: { path: "/workspaces/demo.worktrees/spike" },
          object: { id: "4", type: "worktree" },
          verb: "worktree.adopted",
        })
      )
    ).toBe("opendevhub found worktree spike, created outside opendevhub");
  });

  it("names the actor, the task and the details", () => {
    expect(
      eventText(
        event({
          actor: { id: "tsk_1/2", type: "variant" },
          data: { error: "no space left" },
          object: { id: "tsk_1/2", type: "variant" },
          taskTitle: "Add login",
          verb: "variant.failed",
        })
      )
    ).toBe("Variant 2 of “Add login” failed: no space left");
    expect(
      eventText(
        event({
          data: { kind: "task", title: "Add login", variants: 3 },
          taskTitle: "Add login",
        })
      )
    ).toBe("You started task “Add login” with 3 variants");
    expect(
      eventText(
        event({
          data: {
            branch: "task/a",
            role: "head",
            url: "https://forge.example/o/r/pulls/12",
          },
          object: { id: "3", type: "pull_request" },
          verb: "pull_request.linked",
        })
      )
    ).toBe("Branch task/a became PR #12");
    expect(pullLabel(undefined)).toBe("a pull request");
  });
});

describe(eventLink, () => {
  it("links to the entity's page, or what is left of it", () => {
    expect(eventLink(event({ taskId: "tsk_1" }))).toStrictEqual({
      href: "/p/demo/t/tsk_1",
    });
    expect(
      eventLink(
        event({
          data: { path: "/w/demo.worktrees/feat" },
          object: { id: "2", type: "worktree" },
          verb: "worktree.created",
        })
      )
    ).toStrictEqual({ href: "/p/demo/w/feat" });
    expect(
      eventLink(
        event({
          data: { path: "/w/demo.worktrees/feat" },
          object: { id: "2", type: "worktree" },
          verb: "worktree.removed",
        })
      )
    ).toStrictEqual({ href: "/p/demo" });
    expect(
      eventLink(
        event({
          data: { url: "https://forge.example/o/r/pulls/1" },
          object: { id: "5", type: "review" },
          verb: "review.run",
        })
      )
    ).toStrictEqual({ external: "https://forge.example/o/r/pulls/1" });
    expect(
      eventLink(
        event({
          data: { key: "APP-42" },
          object: { id: "1", type: "ticket" },
          verb: "ticket.linked",
        })
      )
    ).toStrictEqual({ href: "/jira/APP-42" });
  });
});

describe(mergeEvents, () => {
  it("keeps each event once, newest first", () => {
    const ids = (list: ActivityEvent[]) => list.map((e) => e.id);
    expect(
      ids(
        mergeEvents(
          [event({ id: 9 }), event({ id: 8 })],
          [event({ id: 8 }), event({ id: 3 })]
        )
      )
    ).toStrictEqual([9, 8, 3]);
    expect(filterKey({ entity: { id: "4", type: "worktree" } })).toBe(
      "||worktree:4"
    );
  });
});

describe("created-by origins", () => {
  it("labels each kind of creator", () => {
    expect(
      originLabel({ by: "variant", n: 1, task: "tsk_1", title: "Add login" })
    ).toStrictEqual({ text: "Add login · variant 1" });
    expect(originLabel({ by: "unmanaged" })).toStrictEqual({
      text: "Created outside opendevhub",
    });
    expect(
      originLabel(
        { by: "pull", url: "https://forge.example/o/r/pulls/3" },
        "https://forge.example"
      )
    ).toStrictEqual({
      href: "/forgejo/o/r/3",
      text: "Pull request checkout",
    });
    expect(
      originLabel({ by: "pull", url: "https://github.com/o/r/pull/3" })
    ).toStrictEqual({
      external: "https://github.com/o/r/pull/3",
      text: "Pull request checkout",
    });
  });

  it("tells sessions of a variant, started here, and found in opencode apart", () => {
    const ref = { discarded: false, id: "tsk_1", n: 2 };
    expect(sessionOrigin({ ...ref, kind: "task" }, "Add login")).toStrictEqual({
      by: "variant",
      n: 2,
      task: "tsk_1",
      title: "Add login",
    });
    expect(sessionOrigin({ ...ref, kind: "manual" }, "Fix")).toStrictEqual({
      by: "session",
      kind: "manual",
      task: "tsk_1",
      title: "Fix",
    });
    expect(
      sessionOrigin({ ...ref, adopted: true, kind: "manual" }, "Fix")
    ).toStrictEqual({ by: "unmanaged" });
  });
});
