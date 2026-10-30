// MSW handlers for every route the dashboard calls, so pages render in Storybook without a server.
import { delay, http, HttpResponse, sse, ws } from "msw";
import type { AnyHandler } from "msw";

import type {
  AiReviewResult,
  ForgejoFilterPreset,
  ForgejoPresetFilters,
  ForgejoSettings,
} from "../../shared/forgejo";
import type { GitSetup } from "../../shared/git-setup";
import type { JiraFilterPreset, JiraSettings } from "../../shared/jira";
import type {
  OcrProjectSettings,
  OcrSettings,
  OcrSettingsInput,
  OcrTestResult,
} from "../../shared/ocr";
import {
  readPersonalization,
  readProjectPersonalization,
  resolvePersonalization,
} from "../../shared/personalization";
import type {
  Personalization,
  ProjectPersonalization,
} from "../../shared/personalization";
import type {
  AppPreferences,
  BasePosition,
  DashboardSnapshot,
  ProjectLinks,
  ProjectTodo,
  ReviewData,
  SavedPermission,
  SavedPermissionsView,
  SessionDetail,
} from "../../shared/types";
import {
  activityPage,
  basePosition,
  provenanceOf,
  candidates,
  checksView,
  projectTeamView,
  composerAgents,
  composerCommands,
  composerFiles,
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
  gitSetup,
  jiraBoardColumns,
  jiraCatalog,
  jiraSettings,
  reviewImage,
  jiraTicket,
  jiraTickets,
  envLogs,
  savedPermissions,
  logLines,
  models,
  ocrReview,
  ocrSettings,
  projectOcrDefault,
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
  git?: GitSetup;
  /** Milliseconds every REST response waits, to show loading states. */
  latency?: number;
  ocr?: OcrSettings;
  /** Every project's Open Code Review settings. */
  projectOcr?: OcrProjectSettings;
  /** What Test connection answers. */
  ocrTest?: OcrTestResult;
  /** Every environment's saved permissions; removing and editing change this copy. */
  savedPermissions?: SavedPermissionsView;
  /** What `GET base-position` answers for a base; up to date by default. Pull makes it up to date. */
  basePosition?: (base: string) => BasePosition;
  /** Changes every checkout's review data, e.g. its ahead/behind or pushed state. */
  review?: (data: ReviewData) => ReviewData;
  preferences?: AppPreferences;
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

/** A session's detail with a revert staged at user message `messageId`: that message and later ones left out. */
const withRevert = (
  detail: SessionDetail,
  messageId: string
): SessionDetail => {
  const at = detail.transcript.findIndex((m) => m.id === messageId);
  if (at === -1) {
    return detail;
  }
  const boundary = detail.transcript[at].created;
  return {
    ...detail,
    revert: {
      files: [
        { additions: 0, deletions: 12, path: "src/server/rate-limit.ts" },
        { additions: 2, deletions: 1, path: "src/server/routes.ts" },
      ],
      hidden: detail.transcript.length - at,
      messageId,
    },
    transcript: detail.transcript.slice(0, at),
    turns: detail.turns.filter((t) => t.created < boundary),
  };
};

export const createHandlers = (options: MockOptions = {}): AnyHandler[] => {
  const {
    snapshot: snap = snapshot,
    forgejo = forgejoSettings,
    jira = jiraSettings,
    git = gitSetup,
    latency = 0,
    projectOcr = projectOcrDefault,
    ocrTest = { ok: true },
  } = options;
  let ocr = options.ocr ?? ocrSettings;
  let preferences: AppPreferences = options.preferences ?? {
    updateBaseBeforeTask: true,
  };
  const pulled = new Set<string>();
  const positionOf = (base: string): BasePosition =>
    pulled.has(base)
      ? basePosition(base)
      : (options.basePosition?.(base) ?? basePosition(base));
  const saved = structuredClone(options.savedPermissions ?? savedPermissions());
  let personalization: Personalization = readPersonalization({
    features: { "ghcr.io/devcontainers/features/github-cli:1": {} },
    setupCommand: "git config --global alias.co checkout",
  });
  const projectPersonalization = new Map<string, ProjectPersonalization>();
  /** Each session's staged revert, by the user message it is staged at. */
  const reverts = new Map<string, string>();
  const projectPersonalizationView = (id: string) => {
    const own =
      projectPersonalization.get(id) ?? readProjectPersonalization(undefined);
    return {
      effective: resolvePersonalization(personalization, own),
      global: personalization,
      personalization: own,
      rebuildNeeded: projectPersonalization.has(id),
    };
  };
  let presets: ForgejoFilterPreset[] = [
    {
      filters: { inbox: "review-requested", state: "open" },
      id: 1,
      name: "Waiting on me",
    },
  ];
  let jiraPresets: JiraFilterPreset[] = [
    {
      filters: {
        jql: "labels = backend",
        scope: "board",
        board: 1,
        search: "",
        sort: "rank",
        status: "open",
      },
      id: 1,
      name: "Backend on the board",
    },
  ];
  const projectLinks = new Map<string, ProjectLinks>();
  let todos: ProjectTodo[] = [
    { createdAt: 0, done: true, id: 1, text: "Set up the staging database" },
    { createdAt: 0, done: false, id: 2, text: "Rotate the Stripe API key" },
    { createdAt: 0, done: false, id: 3, text: "Write the release notes" },
  ];
  const defaultLinks: ProjectLinks = {
    forgejoRepository: "acme/web",
    jiraBoard: { id: 1, name: "ACME Sprint Board" },
  };
  const wait = async () => {
    if (latency > 0) {
      await delay(latency);
    }
  };

  return [
    ws.link("*/api/terminal").addEventListener("connection", ({ client }) => {
      client.send(JSON.stringify({ type: "ready" }));
      client.send(
        JSON.stringify({
          data: "Storybook terminal preview\r\n$ ",
          type: "output",
        })
      );
    }),
    http.get("/api/access", () => HttpResponse.json({ ok: true })),
    http.post("/api/projects/:id/config-approvals", () =>
      HttpResponse.json({ ok: true })
    ),
    http.delete("/api/projects/:id/config-approvals/:fingerprint", () =>
      HttpResponse.json({ ok: true })
    ),
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
    http.get("/api/forgejo/presets", () => HttpResponse.json({ presets })),
    http.post("/api/forgejo/presets", async ({ request }) => {
      const input = (await request.json()) as Omit<ForgejoFilterPreset, "id">;
      const preset = {
        ...input,
        id: Math.max(0, ...presets.map((p) => p.id)) + 1,
      };
      presets = [...presets, preset];
      return HttpResponse.json(preset);
    }),
    http.put("/api/forgejo/presets/:id", async ({ params, request }) => {
      const changes = (await request.json()) as {
        name?: string;
        filters?: ForgejoPresetFilters;
      };
      presets = presets.map((p) =>
        String(p.id) === params.id ? { ...p, ...changes } : p
      );
      return HttpResponse.json(presets.find((p) => String(p.id) === params.id));
    }),
    http.delete("/api/forgejo/presets/:id", ({ params }) => {
      presets = presets.filter((p) => String(p.id) !== params.id);
      return HttpResponse.json({ ok: true });
    }),
    http.get("/api/forgejo/orgs", () =>
      HttpResponse.json({ orgs: ["acme", "acme-labs"] })
    ),
    http.get("/api/forgejo/users", ({ request }) => {
      const q = new URL(request.url).searchParams.get("q")?.toLowerCase() ?? "";
      const users = [
        { fullName: "Alex Kim", login: "alex" },
        { fullName: "Sam Ortiz", login: "sam" },
        { fullName: "Tim", login: "tim" },
      ].filter((u) => `${u.login} ${u.fullName}`.toLowerCase().includes(q));
      return HttpResponse.json({ users });
    }),
    http.get("/api/forgejo/orgs/:org/teams", () =>
      HttpResponse.json({ teams: ["backend", "frontend", "platform"] })
    ),
    http.get("/api/forgejo/pulls", async ({ request }) => {
      await wait();
      const url = new URL(request.url);
      const state = url.searchParams.get("state") ?? "all";
      const q = url.searchParams.get("q")?.toLowerCase() ?? "";
      const authors = url.searchParams.get("authors")?.split(",") ?? [];
      const pulls = forgejoPulls.filter(
        (p) =>
          (!authors.length || authors.includes(p.author ?? "")) &&
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
    http.post(
      "/api/forgejo/pulls/:owner/:repo/:number/ocr-review",
      async () => {
        await delay(1500);
        return HttpResponse.json(ocrReview);
      }
    ),
    http.get("/api/ocr/runs/:id/logs", () =>
      HttpResponse.json({ lines: ["[ocr] Reviewing changed files…"] })
    ),
    http.get("/api/ocr/settings", async () => {
      await wait();
      return HttpResponse.json(ocr);
    }),
    http.put("/api/ocr/settings", async ({ request }) => {
      const input = (await request.json()) as OcrSettingsInput;
      const { key, clearKey, ...provider } = input.provider;
      ocr = {
        ...ocr,
        limits: input.limits,
        provider: {
          ...provider,
          hasKey: clearKey ? false : !!key || ocr.provider.hasKey,
        },
      };
      return HttpResponse.json(ocr);
    }),
    http.post("/api/ocr/settings/test", async () => {
      await delay(600);
      return HttpResponse.json(ocrTest);
    }),
    http.post("/api/ocr/settings/import", () =>
      HttpResponse.json({
        key: "sk-imported",
        model: "vllm/coding",
        preset: "custom",
        protocol: "openai",
        url: "https://ask-ai.example.com/api",
      })
    ),
    http.post("/api/ocr/install", async () => {
      await delay(800);
      return HttpResponse.json({ installed: true });
    }),
    http.get("/api/settings/personalization", async () => {
      await wait();
      return HttpResponse.json({ personalization });
    }),
    http.put("/api/settings/personalization", async ({ request }) => {
      personalization = readPersonalization(await request.json());
      return HttpResponse.json({ personalization });
    }),
    http.get("/api/projects/:id/personalization", async ({ params }) => {
      await wait();
      return HttpResponse.json(projectPersonalizationView(String(params.id)));
    }),
    http.put(
      "/api/projects/:id/personalization",
      async ({ params, request }) => {
        const id = String(params.id);
        projectPersonalization.set(
          id,
          readProjectPersonalization(await request.json())
        );
        return HttpResponse.json(projectPersonalizationView(id));
      }
    ),
    http.get("/api/projects/:id/ocr", async () => {
      await wait();
      return HttpResponse.json(projectOcr);
    }),
    http.put("/api/projects/:id/ocr", () => HttpResponse.json(projectOcr)),
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
    http.get("/api/jira/presets", () =>
      HttpResponse.json({ presets: jiraPresets })
    ),
    http.post("/api/jira/presets", async ({ request }) => {
      const input = (await request.json()) as Omit<JiraFilterPreset, "id">;
      const preset = {
        ...input,
        id: Math.max(0, ...jiraPresets.map((p) => p.id)) + 1,
      };
      jiraPresets = [...jiraPresets, preset];
      return HttpResponse.json(preset);
    }),
    http.put("/api/jira/presets/:id", async ({ params, request }) => {
      const changes = (await request.json()) as Partial<JiraFilterPreset>;
      jiraPresets = jiraPresets.map((p) =>
        String(p.id) === params.id ? { ...p, ...changes } : p
      );
      return HttpResponse.json(
        jiraPresets.find((p) => String(p.id) === params.id)
      );
    }),
    http.delete("/api/jira/presets/:id", ({ params }) => {
      jiraPresets = jiraPresets.filter((p) => String(p.id) !== params.id);
      return HttpResponse.json({ ok: true });
    }),
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
    http.post("/api/push/test", () => HttpResponse.json({ sent: 1 })),
    http.get("/api/push/browsers", () => HttpResponse.json([])),
    http.post("/api/push/unsubscribe", ok),

    http.get("/api/settings/preferences", async () => {
      await wait();
      return HttpResponse.json(preferences);
    }),
    http.put("/api/settings/preferences", async ({ request }) => {
      preferences = (await request.json()) as AppPreferences;
      return HttpResponse.json(preferences);
    }),
    http.get("/api/projects/:id/base-position", async ({ request }) => {
      await wait();
      const base = new URL(request.url).searchParams.get("base") || "main";
      return HttpResponse.json(positionOf(base));
    }),
    http.post("/api/projects/:id/base-position/pull", async ({ request }) => {
      await delay(400);
      const { base = "main" } = (await request.json()) as { base?: string };
      pulled.add(base);
      return HttpResponse.json(positionOf(base));
    }),

    // Settings
    http.get("/api/settings/git", async () => {
      await wait();
      return HttpResponse.json(git);
    }),
    http.post("/api/settings/git/test", async ({ request }) => {
      const { host } = (await request.json()) as { host: string };
      await delay(400);
      return host.startsWith("[")
        ? HttpResponse.json({
            message: "git@git.internal: Permission denied (publickey).",
            ok: false,
          })
        : HttpResponse.json({
            message:
              "Hi there, dev! You've successfully authenticated with the key named dev@laptop",
            ok: true,
          });
    }),
    http.post("/api/projects/:id/name", ok),

    // Per project
    http.get("/api/projects/:id/logs", () =>
      HttpResponse.json({ lines: logLines })
    ),
    http.get("/api/projects/:id/envs/:env/logs", ({ request }) =>
      HttpResponse.json(
        envLogs(new URL(request.url).searchParams.get("source") ?? "setup")
      )
    ),
    http.get("/api/projects/:id/envs/:env/permissions/saved", async () => {
      await wait();
      return HttpResponse.json(saved);
    }),
    http.patch(
      "/api/projects/:id/envs/:env/permissions/saved/:rule",
      async ({ params, request }) => {
        await wait();
        const changes = (await request.json()) as Partial<SavedPermission>;
        const rule = saved.rules.find((r) => r.id === params.rule);
        if (!rule) {
          return HttpResponse.json(
            { error: "saved permission not found" },
            { status: 404 }
          );
        }
        Object.assign(rule, changes, { updatedAt: Date.now() });
        return HttpResponse.json(rule);
      }
    ),
    http.delete(
      "/api/projects/:id/envs/:env/permissions/saved/:rule",
      async ({ params }) => {
        await wait();
        saved.rules = saved.rules.filter((r) => r.id !== params.rule);
        return ok();
      }
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
      const data = (options.review ?? ((d: ReviewData) => d))(
        reviewData(directory)
      );
      const file = query.get("file");
      if (file) {
        // One file's patch, as the server sends one that was too large for the list.
        const lines = Array.from(
          { length: 12 },
          (_, i) => `+it("case ${i + 1}");`
        );
        return HttpResponse.json({
          ...data,
          files: data.files
            .filter((f) => f.file === file)
            .map((f) => ({
              ...f,
              patch:
                f.patch ??
                `diff --git a/${f.file} b/${f.file}\nnew file mode 100644\n--- /dev/null\n+++ b/${f.file}\n@@ -0,0 +1,12 @@\n${lines.join("\n")}\n`,
            })),
        });
      }
      return HttpResponse.json(data);
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
    http.get("/api/projects/:id/links", ({ params }) =>
      HttpResponse.json(projectLinks.get(String(params.id)) ?? defaultLinks)
    ),
    http.post("/api/projects/:id/links", async ({ params, request }) => {
      const { scope: _scope, ...links } =
        (await request.json()) as ProjectLinks & {
          scope?: string;
        };
      projectLinks.set(String(params.id), links);
      return HttpResponse.json(links);
    }),
    http.get("/api/projects/:id/team-settings", () =>
      HttpResponse.json(projectTeamView)
    ),
    http.get("/api/projects/:id/todos", () => HttpResponse.json({ todos })),
    http.post("/api/projects/:id/todos", async ({ request }) => {
      const { text } = (await request.json()) as { text: string };
      const todo: ProjectTodo = {
        createdAt: Date.now(),
        done: false,
        id: Math.max(0, ...todos.map((t) => t.id)) + 1,
        text,
      };
      todos = [...todos, todo];
      return HttpResponse.json(todo);
    }),
    http.patch("/api/projects/:id/todos/:todo", async ({ params, request }) => {
      const changes = (await request.json()) as Partial<ProjectTodo>;
      todos = todos.map((t) =>
        String(t.id) === params.todo ? { ...t, ...changes } : t
      );
      return HttpResponse.json(todos.find((t) => String(t.id) === params.todo));
    }),
    http.delete("/api/projects/:id/todos/:todo", ({ params }) => {
      todos = todos.filter((t) => String(t.id) !== params.todo);
      return HttpResponse.json({ ok: true });
    }),
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
    http.post("/api/projects/:id/checks/cancel", () =>
      HttpResponse.json({ run: checksView.run })
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
      HttpResponse.json({ chat: "c_idle", sessionId: "ses_new03" })
    ),
    http.get("/api/projects/:id/composer/commands", async () => {
      await wait();
      return HttpResponse.json({ commands: composerCommands });
    }),
    http.get("/api/projects/:id/composer/agents", async () => {
      await wait();
      return HttpResponse.json({ agents: composerAgents });
    }),
    http.get("/api/projects/:id/composer/files", async ({ request }) => {
      await wait();
      const query = new URL(request.url).searchParams.get("query") ?? "";
      return HttpResponse.json({
        files: composerFiles.filter((f) => f.includes(query)),
      });
    }),
    http.post("/api/projects/:id/chat", () =>
      HttpResponse.json({ chat: "c_idle" })
    ),
    http.get("/api/projects/:id/chats/:chat/brief", async () => {
      await wait();
      return HttpResponse.json({
        brief:
          "## Goal\nA dark mode toggle in Settings that follows the system by default.\n\n## Decisions so far\n- Tailwind's `dark` class on `<html>`\n- Remember the choice in localStorage\n\n## Open questions\n- Should charts switch palettes too?",
      });
    }),
    http.get("/api/projects/:id/chats/:chat/suggestions", () =>
      HttpResponse.json({
        pullRequests: [],
        tickets: ["ACME-142"],
      })
    ),
    http.post("/api/projects/:id/chats/:chat/task", () =>
      HttpResponse.json({ task: "tsk_new" })
    ),
    http.post("/api/projects/:id/chats/:chat/archive", ok),
    http.get("/api/projects/:id/chats/:chat", ({ params }) =>
      params.chat === "c_round"
        ? HttpResponse.json({ adoptedBy: { n: 1, task: "tsk_round" } })
        : HttpResponse.json({ error: "no such chat" }, { status: 404 })
    ),
    http.post("/api/projects/:id/drafts", () =>
      HttpResponse.json({ task: "tsk_sso" })
    ),
    http.post("/api/projects/:id/drafts/ticket", () =>
      HttpResponse.json({ task: "tsk_sso" })
    ),
    http.put("/api/projects/:id/tasks/:task/draft", ok),
    http.post("/api/projects/:id/tasks/:task/start", ({ params }) =>
      HttpResponse.json({ task: params.task, variants: [] })
    ),
    http.get("/api/projects/:id/tasks/archived", () => HttpResponse.json([])),
    http.post("/api/projects/:id/tasks/:task/restore", ok),
    http.delete("/api/projects/:id/tasks/:task", ok),
    http.post("/api/projects/:id/sessions/:session/send", () =>
      HttpResponse.json({ kind: "prompt", queued: false })
    ),
    http.get("/api/projects/:id/sessions/:session", async ({ params }) => {
      await wait();
      const detail = sessionDetail(String(params.session));
      const at = reverts.get(String(params.session));
      return detail
        ? HttpResponse.json(at ? withRevert(detail, at) : detail)
        : HttpResponse.json({ error: "unknown session" }, { status: 404 });
    }),
    http.post(
      "/api/projects/:id/sessions/:session/checkpoint",
      async ({ params, request }) => {
        const { messageId } = (await request.json()) as { messageId: string };
        reverts.set(String(params.session), messageId);
        return ok();
      }
    ),
    http.delete(
      "/api/projects/:id/sessions/:session/checkpoint",
      ({ params }) => {
        reverts.delete(String(params.session));
        return ok();
      }
    ),
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
