// MSW handlers for every route the dashboard calls, so pages render in Storybook without a server.
import { delay, http, HttpResponse, sse } from "msw";
import type { AnyHandler } from "msw";

import type { AiReviewResult, ForgejoSettings } from "../../shared/forgejo";
import type { JiraSettings } from "../../shared/jira";
import type { DashboardSnapshot } from "../../shared/types";
import {
  activityPage,
  provenanceOf,
  candidates,
  checksView,
  specView,
  cleanupPlan,
  forgejoApprovals,
  forgejoChecks,
  forgejoComments,
  forgejoDetails,
  forgejoPulls,
  forgejoReviewComments,
  forgejoReviews,
  forgejoSettings,
  jiraBoardColumns,
  jiraCatalog,
  jiraSettings,
  reviewImage,
  jiraTicket,
  jiraTickets,
  logLines,
  models,
  PATCH,
  publishInfo,
  pullLinks,
  reviewData,
  sessionDetail,
  turnReviewData,
  snapshot,
  ticketLinks,
  usageReport,
} from "./fixtures";

/** What a story can swap; anything left out uses the default fixtures. */
export interface MockOptions {
  /** `null` keeps the event stream open without ever sending a snapshot (the loading state). */
  snapshot?: DashboardSnapshot | null;
  forgejo?: ForgejoSettings;
  jira?: JiraSettings;
  /** Milliseconds every REST response waits, to show loading states. */
  latency?: number;
}

const aiReview: AiReviewResult = {
  findings: [
    {
      body: "`MAX_BURST` is checked before pruning old hits for other keys, so the map grows without bound.",
      file: "src/server/rate-limit.ts",
      line: 9,
      severity: "major",
      side: "new",
    },
    {
      body: "`limit` is created but never applied to `/login`.",
      file: "src/server/routes.ts",
      line: 11,
      severity: "blocker",
      side: "new",
    },
    { body: "Consider documenting the new 429 behaviour.", severity: "nit" },
  ],
  sessionId: "ses_ai01",
  summary:
    "The burst check is sound, but the limiter is never wired into the login route.",
};

const ok = () => HttpResponse.json({ ok: true });

export const createHandlers = (options: MockOptions = {}): AnyHandler[] => {
  const {
    snapshot: snap = snapshot,
    forgejo = forgejoSettings,
    jira = jiraSettings,
    latency = 0,
  } = options;
  const wait = async () => {
    if (latency > 0) {
      await delay(latency);
    }
  };

  return [
    sse<{ snapshot: string; log: string }>("/api/events", ({ client }) => {
      if (snap) {
        client.send({ data: JSON.stringify(snap), event: "snapshot" });
      }
    }),

    // Integrations
    http.get("/api/forgejo/settings", () => HttpResponse.json(forgejo)),
    http.post("/api/forgejo/settings", async ({ request }) => {
      const input = (await request.json()) as { enabled: boolean; url: string };
      return HttpResponse.json({ ...forgejo, ...input, hasToken: true });
    }),
    http.post("/api/forgejo/test", () =>
      HttpResponse.json({ username: "tim", version: "13.0.2" })
    ),
    http.get("/api/jira/settings", () => HttpResponse.json(jira)),
    http.post("/api/jira/settings", async ({ request }) => {
      const input = (await request.json()) as { enabled: boolean; url: string };
      return HttpResponse.json({ ...jira, ...input, hasToken: true });
    }),

    // Forgejo
    http.get("/api/forgejo/orgs", () =>
      HttpResponse.json({ orgs: ["acme", "acme-labs"] })
    ),
    http.get("/api/forgejo/orgs/:org/teams", () =>
      HttpResponse.json({ teams: ["backend", "frontend", "platform"] })
    ),
    http.get("/api/forgejo/pulls", async ({ request }) => {
      await wait();
      const url = new URL(request.url);
      const state = url.searchParams.get("state") ?? "all";
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      const pulls = forgejoPulls.filter(
        (p) =>
          (state === "all" ||
            (state === "open" ? p.state === "open" : p.state !== "open")) &&
          p.title.toLowerCase().includes(q)
      );
      return HttpResponse.json({ pulls, username: "tim" });
    }),
    http.get("/api/forgejo/pulls/:owner/:repo/:number", async () => {
      await wait();
      return HttpResponse.json(forgejoDetails);
    }),
    http.get("/api/forgejo/pulls/:owner/:repo/:number/patch", () =>
      HttpResponse.json({ patch: PATCH })
    ),
    http.get(
      "/api/forgejo/pulls/:owner/:repo/:number/approvals",
      ({ params }) => HttpResponse.json(forgejoApprovals(Number(params.number)))
    ),
    http.get("/api/forgejo/pulls/:owner/:repo/:number/comments", () =>
      HttpResponse.json({ items: forgejoComments })
    ),
    http.get("/api/forgejo/pulls/:owner/:repo/:number/reviews", () =>
      HttpResponse.json({ items: forgejoReviews })
    ),
    http.get(
      "/api/forgejo/pulls/:owner/:repo/:number/reviews/:id/comments",
      () => HttpResponse.json(forgejoReviewComments)
    ),
    http.post("/api/forgejo/pulls/:owner/:repo/:number/reviews", ok),
    http.post("/api/forgejo/pulls/:owner/:repo/:number/worktree", () =>
      HttpResponse.json({
        worktree: {
          branch: forgejoDetails.head,
          path: "/workspaces/.worktrees/acme-web/pr-42",
        },
      })
    ),
    http.post("/api/forgejo/pulls/:owner/:repo/:number/ai-review/session", () =>
      HttpResponse.json({ sessionId: aiReview.sessionId })
    ),
    http.post("/api/forgejo/pulls/:owner/:repo/:number/ai-review", async () => {
      await delay(800);
      return HttpResponse.json(aiReview);
    }),
    http.get("/api/forgejo/pulls/:owner/:repo/:number/ai-reviews", () =>
      HttpResponse.json({ reviews: pullLinks(forgejoDetails.pull.url).reviews })
    ),
    http.get("/api/activity", async ({ request }) => {
      await wait();
      return HttpResponse.json(activityPage(new URL(request.url).searchParams));
    }),
    http.get("/api/provenance/:type/:id", ({ params }) => {
      const found = provenanceOf(String(params.type), String(params.id));
      return found
        ? HttpResponse.json(found)
        : HttpResponse.json({ error: "unknown entity" }, { status: 404 });
    }),
    http.get("/api/links/pull", ({ request }) =>
      HttpResponse.json(
        pullLinks(new URL(request.url).searchParams.get("url") ?? "")
      )
    ),
    http.get("/api/links/ticket", ({ request }) =>
      HttpResponse.json(
        ticketLinks(new URL(request.url).searchParams.get("key") ?? "")
      )
    ),
    http.get("/api/forgejo/checks/:owner/:repo/:sha", () =>
      HttpResponse.json(forgejoChecks)
    ),

    // Jira
    http.get("/api/jira/tickets", async ({ request }) => {
      await wait();
      const params = new URL(request.url).searchParams;
      const search = params.get("search")?.toLowerCase() ?? "";
      const project = params.get("project");
      const status = params.get("status");
      const tickets = jiraTickets.filter(
        (t) =>
          `${t.key} ${t.title}`.toLowerCase().includes(search) &&
          (!project || t.key.startsWith(`${project}-`)) &&
          (status !== "done" || t.status === "Done") &&
          (status !== "todo" || t.status === "To Do") &&
          (status !== "progress" || t.status === "In Progress")
      );
      return HttpResponse.json({ tickets, total: tickets.length });
    }),
    http.get("/api/jira/catalog", () => HttpResponse.json(jiraCatalog)),
    http.get("/api/jira/boards/:id/columns", () =>
      HttpResponse.json(jiraBoardColumns)
    ),
    http.get("/api/jira/tickets/:key", ({ params }) =>
      HttpResponse.json(jiraTicket(String(params.key)))
    ),

    // Dashboard-wide
    http.post("/api/projects/rescan", async () => {
      await delay(600);
      return HttpResponse.json(snap ?? snapshot);
    }),
    http.get("/api/usage", async ({ request }) => {
      await wait();
      const day = new URL(request.url).searchParams.get("day");
      return HttpResponse.json(day ? { ...usageReport, day } : usageReport);
    }),
    http.get("/api/onboarding/candidates", () => HttpResponse.json(candidates)),
    http.post("/api/onboarding", () =>
      HttpResponse.json({ projectId: "design-system", started: true })
    ),
    http.get("/api/cleanup", async () => {
      await wait();
      return HttpResponse.json(cleanupPlan);
    }),
    http.post("/api/cleanup", async ({ request }) => {
      const { items } = (await request.json()) as { items: { id: string }[] };
      await delay(500);
      return HttpResponse.json({
        freedBytes: 3.2 * 1024 ** 3,
        results: items.map(({ id }) => ({ id, outcome: "removed" })),
      });
    }),
    http.post("/api/nodes", async ({ request }) => {
      const { ssh, label } = (await request.json()) as {
        ssh: string;
        label?: string;
      };
      return HttpResponse.json({
        id: ssh,
        label: label ?? ssh,
        ssh,
        state: "connecting",
      });
    }),
    http.delete("/api/nodes/:id", ok),
    http.get("/api/push/key", () =>
      HttpResponse.json({ error: "push is not mocked" }, { status: 404 })
    ),

    // Per project
    http.get("/api/projects/:id/logs", () =>
      HttpResponse.json({ lines: logLines })
    ),
    http.get("/api/projects/:id/models", () => HttpResponse.json(models)),
    http.get("/api/projects/:id/review", async ({ request }) => {
      await wait();
      const query = new URL(request.url).searchParams;
      const directory = query.get("directory") ?? "";
      if (query.get("mode") === "turn") {
        return HttpResponse.json(
          turnReviewData(directory, query.get("from") ?? undefined)
        );
      }
      return HttpResponse.json(reviewData(directory));
    }),
    http.get("/api/projects/:id/review/image", ({ request }) => {
      const query = new URL(request.url).searchParams;
      return new HttpResponse(
        reviewImage(query.get("file") ?? "", query.get("side") === "old"),
        { headers: { "content-type": "image/svg+xml" } }
      );
    }),
    http.post("/api/projects/:id/review/commit-message", () =>
      HttpResponse.json({
        message: "feat: reject login bursts above 20 requests",
      })
    ),
    http.post("/api/projects/:id/review/commit", ok),
    http.post("/api/projects/:id/review/update", () =>
      HttpResponse.json({ strategy: "rebase" })
    ),
    http.post("/api/projects/:id/review/merge", () =>
      HttpResponse.json({ branch: "main" })
    ),
    http.post("/api/projects/:id/review/bring-home", () =>
      HttpResponse.json({ branch: "feat/rate-limit" })
    ),
    http.get("/api/projects/:id/publish", () => HttpResponse.json(publishInfo)),
    http.post("/api/projects/:id/publish/suggest", () =>
      HttpResponse.json({
        description: "Rejects bursts above 20 requests on `/login`.",
        title: "Add burst limit to the login rate limiter",
      })
    ),
    http.post("/api/projects/:id/publish", () =>
      HttpResponse.json({
        openUrl: "https://git.acme.dev/acme/web/compare/main...feat/rate-limit",
        output: [
          "To git.acme.dev:acme/web.git",
          " * [new branch] feat/rate-limit -> feat/rate-limit",
        ],
        pushedFrom: "host",
        strategy: "branch",
      })
    ),
    http.get("/api/projects/:id/checks", () => HttpResponse.json(checksView)),
    http.get("/api/projects/:id/spec", () => HttpResponse.json(specView)),
    http.post("/api/projects/:id/spec/revise", () =>
      HttpResponse.json({ ok: true })
    ),
    http.post("/api/projects/:id/spec/approve", () =>
      HttpResponse.json({ ok: true })
    ),
    http.post("/api/projects/:id/spec/implement", () =>
      HttpResponse.json({ task: "tsk_impl" })
    ),
    http.post("/api/projects/:id/spec/archive", () =>
      HttpResponse.json({ ok: true })
    ),
    http.get("/api/projects/:id/checks/run", () =>
      HttpResponse.json({ run: checksView.run })
    ),
    http.post("/api/projects/:id/checks/run", () =>
      HttpResponse.json(checksView.run)
    ),
    http.post("/api/projects/:id/checks/settings", () =>
      HttpResponse.json(checksView)
    ),
    http.post("/api/projects/:id/tasks", () =>
      HttpResponse.json({
        task: "tsk_new",
        variants: [{ branch: "feat/new-task", sessionId: "ses_new01" }],
      })
    ),
    http.post("/api/projects/:id/tasks/:task/pick", () =>
      HttpResponse.json({ discarded: ["ses_var02"], errors: [], removed: [] })
    ),
    http.delete("/api/projects/:id/tasks/:task/starting", ok),
    http.post("/api/projects/:id/worktrees", () =>
      HttpResponse.json({
        sessionId: "ses_new02",
        worktree: { branch: "feat/new", path: "/workspaces/.worktrees/new" },
      })
    ),
    http.post("/api/projects/:id/worktrees/remove", ok),
    http.post("/api/projects/:id/worktrees/refresh", ({ params }) =>
      HttpResponse.json({
        worktrees:
          (snap ?? snapshot).projects.find((v) => v.project.id === params.id)
            ?.runtime.worktrees ?? [],
      })
    ),
    http.post("/api/projects/:id/sessions", () =>
      HttpResponse.json({ sessionId: "ses_new03" })
    ),
    http.get("/api/projects/:id/sessions/:session", async ({ params }) => {
      await wait();
      const detail = sessionDetail(String(params.session));
      return detail
        ? HttpResponse.json(detail)
        : HttpResponse.json({ error: "unknown session" }, { status: 404 });
    }),
    http.post("/api/projects/:id/sessions/:session/prompt", ok),
    http.delete("/api/projects/:id/sessions/:session", ok),
    http.post("/api/projects/:id/permissions/:request", ok),
    http.post("/api/projects/:id/forms/:form", ok),
    http.delete("/api/projects/:id/forms/:form", ok),
    http.post("/api/projects/:id/open", ok),
    http.post("/api/projects/:id/envs", () =>
      HttpResponse.json({ envId: "acme-web-new" })
    ),
    http.post("/api/projects/:id/envs/:env/remove", ok),
    http.post("/api/projects/:id/envs/:env/:action", ok),
    // Last, so the routes above win: start, stop, rebuild, rebuild-no-cache, restart-opencode.
    http.post("/api/projects/:id/:action", async () => {
      await delay(400);
      return ok();
    }),
  ];
};

/** A route that fails, for error-state stories. */
export const failing = (
  method: "get" | "post",
  path: string,
  error: string,
  status = 500
): AnyHandler =>
  http[method](path, () => HttpResponse.json({ error }, { status }));

/** A route that never answers, for loading-state stories. */
export const pending = (method: "get" | "post", path: string): AnyHandler =>
  http[method](path, async () => {
    await delay("infinite");
    return ok();
  });
