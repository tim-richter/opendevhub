// Mock data for Storybook. Shapes follow src/shared; values describe a plausible day with two projects.
import type {
  ActivityEvent,
  ActivityPage,
  Provenance,
  ProvenanceStep,
} from "../../shared/activity";
import type {
  ForgejoApprovals,
  ForgejoChecks,
  ForgejoComment,
  ForgejoPullDetails,
  ForgejoPullRequest,
  ForgejoReview,
  ForgejoSettings,
} from "../../shared/forgejo";
import type { GitSetup } from "../../shared/git-setup";
import type {
  JiraBoardColumn,
  JiraCatalog,
  JiraSettings,
  JiraTicket,
  JiraTicketSummary,
} from "../../shared/jira";
import type {
  CandidateList,
  PullLinks,
  PullRequestRef,
  TicketLinks,
  TicketRef,
  ChecksView,
  SpecView,
  CleanupPlan,
  DashboardSnapshot,
  EnvironmentView,
  ModelsInfo,
  NodeView,
  ProjectView,
  PublishInfo,
  ReviewData,
  SessionDetail,
  SessionSummary,
  UsageReport,
} from "../../shared/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

const now = Date.now();
const ago = (ms: number): number => now - ms;
const isoAgo = (ms: number): string => new Date(ago(ms)).toISOString();

export const RATE_LIMIT_PATCH = `diff --git a/src/server/rate-limit.ts b/src/server/rate-limit.ts
index 3b18e1a..7c9d2f4 100644
--- a/src/server/rate-limit.ts
+++ b/src/server/rate-limit.ts
@@ -1,12 +1,16 @@
 const WINDOW_MS = 60_000;
+const MAX_BURST = 20;
 
 export const createLimiter = (limit: number) => {
   const hits = new Map<string, number[]>();
   return (key: string): boolean => {
     const t = Date.now();
     const recent = (hits.get(key) ?? []).filter((h) => t - h < WINDOW_MS);
+    if (recent.length >= MAX_BURST) {
+      return false;
+    }
     recent.push(t);
     hits.set(key, recent);
     return recent.length <= limit;
   };
 };
`;

const ROUTES_PATCH = `diff --git a/src/server/routes.ts b/src/server/routes.ts
index 81aa0c2..5f3e7b1 100644
--- a/src/server/routes.ts
+++ b/src/server/routes.ts
@@ -10,4 +10,6 @@ import { createLimiter } from "./rate-limit";
 const app = new Hono();
+const limit = createLimiter(100);
+
 app.get("/health", (c) => c.text("ok"));
 
 app.post("/login", async (c) => {
`;

export const PATCH = `${RATE_LIMIT_PATCH}${ROUTES_PATCH}`;

const WEB_WORKSPACE = "/workspaces/acme-web";
const WEB_WORKTREE = "/workspaces/.worktrees/acme-web/rate-limit";

/** PR #42 as opendevhub last fetched it: published from tsk_rate's only variant. */
const RATE_LIMIT_PR: PullRequestRef = {
  fetchedAt: ago(10 * MINUTE),
  forge: "forgejo",
  number: 42,
  owner: "acme",
  repo: "web",
  state: "open",
  title: "Add burst limit to the login rate limiter",
  url: "https://git.acme.dev/acme/web/pulls/42",
};

const ACME_118: TicketRef = {
  fetchedAt: ago(5 * MINUTE),
  instanceUrl: "https://acme.atlassian.net",
  key: "ACME-118",
  status: "In Progress",
  title: "Login endpoint needs burst protection",
  url: "https://acme.atlassian.net/browse/ACME-118",
};
const WEB_ISOLATED_WORKTREE = "/workspaces/.worktrees/acme-web/dark-mode";

const webSessions: SessionSummary[] = [
  {
    cost: 0.42,
    directory: WEB_WORKTREE,
    id: "ses_perm01",
    model: { id: "claude-opus-5-5", providerID: "anthropic" },
    pending: {
      forms: [],
      permissions: [
        {
          action: "bash",
          createdAt: ago(2 * MINUTE),
          diff: undefined,
          id: "per_01",
          message: "Run the test suite",
          resources: ["pnpm vitest run test/server/rate-limit.test.ts"],
          save: ["pnpm vitest *"],
          sessionId: "ses_perm01",
        },
      ],
    },
    projectId: "acme-web",
    status: "needs-permission",
    task: { discarded: false, id: "tsk_rate", kind: "task", n: 1 },
    title: "Add burst limit to the login rate limiter",
    tokens: 184_000,
    context: 61_000,
    updatedAt: ago(2 * MINUTE),
  },
  {
    cost: 1.27,
    directory: WEB_ISOLATED_WORKTREE,
    envId: "acme-web-dark",
    id: "ses_run01",
    task: { discarded: false, id: "tsk_dark", kind: "manual", n: 1 },
    model: { id: "claude-sonnet-5-5", providerID: "anthropic" },
    projectId: "acme-web",
    status: "running",
    title: "Dark mode toggle in settings",
    tokens: 512_000,
    updatedAt: ago(30_000),
  },
  {
    cost: 0.08,
    directory: WEB_WORKSPACE,
    id: "ses_form01",
    task: { discarded: false, id: "tsk_form", kind: "manual", n: 1 },
    pending: {
      forms: [
        {
          createdAt: ago(5 * MINUTE),
          fields: [
            {
              key: "strategy",
              options: ["Redis", "In-memory", "Postgres advisory locks"],
              title: "Which store should back the limiter?",
              type: "string",
            },
            {
              description: "Applied per client IP",
              key: "limit",
              minimum: 1,
              title: "Requests per minute",
              type: "number",
            },
          ],
          id: "frm_01",
          sessionId: "ses_form01",
          title: "Rate limiter settings",
        },
      ],
      permissions: [],
    },
    projectId: "acme-web",
    status: "needs-answer",
    title: "Plan rate limiting rollout",
    tokens: 22_000,
    updatedAt: ago(5 * MINUTE),
  },
  {
    cost: 0.31,
    directory: WEB_WORKSPACE,
    id: "ses_idle01",
    task: { discarded: false, id: "tsk_idle", kind: "manual", n: 1 },
    projectId: "acme-web",
    status: "idle",
    title: "Explain the session middleware",
    tokens: 61_000,
    updatedAt: ago(3 * HOUR),
  },
];

const darkEnv: EnvironmentView = {
  id: "acme-web-dark",
  image: { key: "node-22", ref: "opendevhub/acme-web:4f1c2a" },
  openUrl: "http://acme-web-dark.localhost:7777/",
  runtime: {
    containerId: "c0ffee12",
    containerName: "opendevhub-acme-web-dark",
    containerState: "running",
    opencode: "healthy",
    opencodeVersion: "2.3.1",
    ports: [
      {
        containerPort: 5173,
        hostPort: 41_731,
        label: "vite",
        status: "forwarded",
      },
    ],
    projectId: "acme-web",
    workspaceFolder: WEB_ISOLATED_WORKTREE,
  },
  worktree: {
    branch: "feat/dark-mode",
    hostPath: "/home/dev/code/.worktrees/acme-web/dark-mode",
    path: WEB_ISOLATED_WORKTREE,
  },
  worktreeId: 3,
};

export const webProject: ProjectView = {
  environments: [darkEnv],
  isolation: { default: "shared" },
  openUrl: "http://acme-web.localhost:7777/",
  project: {
    devcontainerPath: "/home/dev/code/acme-web/.devcontainer/devcontainer.json",
    id: "acme-web",
    name: "acme-web",
    path: "/home/dev/code/acme-web",
  },
  runtime: {
    containerId: "abc123def456",
    containerIp: "172.18.0.4",
    containerName: "opendevhub-acme-web",
    containerState: "running",
    opencode: "healthy",
    opencodeVersion: "2.3.1",
    ports: [
      {
        containerPort: 3000,
        hostPort: 43_000,
        label: "api",
        status: "forwarded",
      },
      {
        containerPort: 5173,
        hostPort: 45_173,
        label: "web",
        status: "forwarded",
      },
      {
        containerPort: 9229,
        label: "debugger",
        reason: "port in use",
        status: "failed",
      },
    ],
    projectId: "acme-web",
    relay: "active",
    remoteUser: "node",
    sshAgent: "forwarded",
    workspaceFolder: WEB_WORKSPACE,
    worktreeRoot: {
      container: "/workspaces/.worktrees/acme-web",
      host: "/home/dev/code/.worktrees/acme-web",
      mounted: true,
    },
    worktrees: [
      {
        branch: "feat/rate-limit",
        branchId: 1,
        id: 1,
        createdBy: {
          by: "variant",
          n: 1,
          task: "tsk_rate",
          title: "Add burst limit to the login rate limiter",
        },
        head: "7c9d2f4",
        hostPath: "/home/dev/code/.worktrees/acme-web/rate-limit",
        path: WEB_WORKTREE,
      },
      {
        branch: "feat/dark-mode",
        branchId: 2,
        id: 2,
        createdBy: { by: "unmanaged" },
        head: "1a2b3c4",
        hostPath: "/home/dev/code/.worktrees/acme-web/dark-mode",
        path: WEB_ISOLATED_WORKTREE,
      },
    ],
  },
  sessions: webSessions,
  tasks: [
    {
      createdAt: ago(3 * HOUR),
      id: "tsk_old",
      kind: "manual",
      state: "ended",
      title: "Try the new eslint config",
      variants: [
        {
          directory: WEB_WORKSPACE,
          envId: "acme-web",
          n: 1,
          sessionId: "ses_gone01",
          sessionRemoved: true,
          step: "session",
        },
      ],
    },
    {
      createdAt: ago(2 * HOUR),
      id: "tsk_review42",
      kind: "review",
      reviewOf: RATE_LIMIT_PR,
      state: "ended",
      title: "AI review: PR #42 Add burst limit to the login rate limiter",
      variants: [
        {
          directory: WEB_WORKTREE,
          envId: "acme-web",
          n: 1,
          sessionId: "ses_ai00",
          sessionRemoved: true,
          step: "session",
        },
      ],
    },
    {
      createdAt: ago(40 * MINUTE),
      id: "tsk_rate",
      jira: {
        description:
          "Attackers can hammer `/login` within the per-minute window.",
        instanceUrl: "https://acme.atlassian.net",
        key: "ACME-118",
        title: "Login endpoint needs burst protection",
      },
      kind: "task",
      pullRequests: [{ ...RATE_LIMIT_PR, variant: 1 }],
      state: "running",
      ticket: ACME_118,
      title: "Add burst limit to the login rate limiter",
      variants: [
        {
          branch: "feat/rate-limit",
          directory: WEB_WORKTREE,
          envId: "acme-web",
          model: { id: "claude-opus-5-5", providerID: "anthropic" },
          n: 1,
          sessionId: "ses_perm01",
          step: "session",
        },
      ],
    },
    ...(
      [
        ["tsk_dark", "ses_run01", WEB_ISOLATED_WORKTREE, "acme-web-dark"],
        ["tsk_form", "ses_form01", WEB_WORKSPACE, "acme-web"],
        ["tsk_idle", "ses_idle01", WEB_WORKSPACE, "acme-web"],
      ] as const
    ).map(([id, sessionId, directory, envId]) => ({
      createdAt: webSessions.find((x) => x.id === sessionId)?.updatedAt ?? 0,
      id,
      kind: "manual" as const,
      state: "running" as const,
      title: webSessions.find((x) => x.id === sessionId)?.title ?? "",
      variants: [
        { directory, envId, n: 1, sessionId, step: "session" as const },
      ],
    })),
    {
      createdAt: ago(MINUTE),
      id: "tsk_search",
      kind: "task",
      state: "starting",
      title: "Add full-text search to the docs",
      variants: [
        {
          branch: "feat/search-1",
          log: [
            "Creating worktree feat/search-1",
            "Pulling image opendevhub/acme-web:4f1c2a",
          ],
          n: 1,
          step: "image",
        },
        {
          branch: "feat/search-2",
          error: "docker: no space left on device",
          log: [
            "Creating worktree feat/search-2",
            "Starting container",
            "docker: no space left on device",
          ],
          n: 2,
          step: "failed",
        },
      ],
    },
  ],
};

const API_WORKSPACE = "/workspaces/billing-api";

export const apiProject: ProjectView = {
  environments: [],
  isolation: { default: "isolated" },
  openUrl: "http://billing-api.localhost:7777/",
  project: {
    devcontainerPath:
      "/home/dev/code/billing-api/.devcontainer/devcontainer.json",
    id: "billing-api",
    name: "billing-api",
    path: "/home/dev/code/billing-api",
  },
  runtime: {
    containerId: "def456abc123",
    containerName: "opendevhub-billing-api",
    containerState: "running",
    opencode: "healthy",
    opencodeVersion: "2.3.1",
    ports: [
      {
        containerPort: 8080,
        hostPort: 48_080,
        label: "http",
        status: "forwarded",
      },
    ],
    projectId: "billing-api",
    sshAgent: "unavailable",
    sshAgentReason: "SSH_AUTH_SOCK is not set on this machine",
    workspaceFolder: API_WORKSPACE,
    worktrees: [
      {
        branch: "fix/invoice-rounding",
        branchId: 3,
        createdBy: {
          by: "pull",
          url: "https://git.acme.dev/acme/billing/pulls/31",
        },
        head: "9f8e7d6",
        origin: "https://git.acme.dev/acme/billing/pulls/31",
        path: "/workspaces/.worktrees/billing-api/v1",
      },
      {
        branch: "fix/invoice-rounding-2",
        branchId: 4,
        createdBy: {
          by: "variant",
          n: 2,
          task: "tsk_round",
          title: "Fix invoice rounding for JPY",
        },
        head: "6d7e8f9",
        path: "/workspaces/.worktrees/billing-api/v2",
      },
    ],
  },
  sessions: [1, 2].map((variant) => ({
    cost: 0.6 * variant,
    directory: `/workspaces/.worktrees/billing-api/v${variant}`,
    id: `ses_var0${variant}`,
    model:
      variant === 1
        ? { id: "claude-opus-5-5", providerID: "anthropic" }
        : { id: "gpt-6", providerID: "openai" },
    projectId: "billing-api",
    status: variant === 1 ? "idle" : "running",
    task: { discarded: false, id: "tsk_round", kind: "task", n: variant },
    title: "Fix invoice rounding for JPY",
    tokens: 200_000 * variant,
    updatedAt: ago(variant * 20 * MINUTE),
  })),
  tasks: [
    {
      createdAt: ago(HOUR),
      id: "tsk_round",
      kind: "task",
      state: "running",
      title: "Fix invoice rounding for JPY",
      variants: [1, 2].map((n) => ({
        branch: n === 1 ? "fix/invoice-rounding" : "fix/invoice-rounding-2",
        directory: `/workspaces/.worktrees/billing-api/v${n}`,
        envId: "billing-api",
        model:
          n === 1
            ? { id: "claude-opus-5-5", providerID: "anthropic" }
            : { id: "gpt-6", providerID: "openai" },
        n,
        sessionId: `ses_var0${n}`,
        step: "session" as const,
      })),
    },
  ],
};

export const stoppedProject: ProjectView = {
  environments: [],
  openUrl: "http://legacy-cms.localhost:7777/",
  project: {
    devcontainerPath:
      "/home/dev/code/legacy-cms/.devcontainer/devcontainer.json",
    id: "legacy-cms",
    name: "legacy-cms",
    path: "/home/dev/code/legacy-cms",
  },
  runtime: {
    containerState: "stopped",
    opencode: "absent",
    projectId: "legacy-cms",
  },
  sessions: [],
  tasks: [],
};

export const brokenProject: ProjectView = {
  environments: [],
  openUrl: "http://ml-pipeline.localhost:7777/",
  project: {
    devcontainerPath:
      "/home/dev/code/ml-pipeline/.devcontainer/devcontainer.json",
    id: "ml-pipeline",
    name: "ml-pipeline",
    path: "/home/dev/code/ml-pipeline",
  },
  runtime: {
    containerState: "error",
    error:
      "devcontainer up failed: features/cuda: unsupported architecture arm64",
    opencode: "absent",
    projectId: "ml-pipeline",
  },
  sessions: [],
  tasks: [],
};

export const nodes: NodeView[] = [
  {
    id: "local",
    label: "This machine",
    state: "online",
    stats: {
      containers: 3,
      cpus: 12,
      memAvailable: 14 * GIB,
      memTotal: 32 * GIB,
    },
  },
  {
    id: "buildbox",
    label: "buildbox",
    ssh: "dev@buildbox.lan",
    state: "online",
    stats: {
      containers: 1,
      cpus: 64,
      memAvailable: 200 * GIB,
      memTotal: 256 * GIB,
    },
  },
  {
    id: "laptop-old",
    label: "old laptop",
    reason: "ssh: connect to host 10.0.0.12 port 22: Connection timed out",
    ssh: "dev@10.0.0.12",
    state: "unreachable",
  },
];

export const snapshot: DashboardSnapshot = {
  editors: [
    { id: "vscode", label: "VS Code", target: "host" },
    {
      id: "vscode-container",
      label: "VS Code (container)",
      target: "container",
    },
    { id: "zed", label: "Zed", target: "host" },
  ],
  nodes,
  preflight: { errors: [] },
  projects: [webProject, apiProject, stoppedProject, brokenProject],
  resources: {
    "acme-web": { cpu: 37, memory: 1800 * MIB, memoryLimit: 8 * GIB },
    "acme-web-dark": { cpu: 142, memory: 2600 * MIB, memoryLimit: 8 * GIB },
    "billing-api": { cpu: 4, memory: 640 * MIB, memoryLimit: 4 * GIB },
  },
  activity: { latestId: 14 },
  roots: ["/home/dev/code"],
  usage: {
    projects: {
      "acme-web": {
        today: { cost: 2.08, tokens: 779_000 },
        total: { cost: 48.12, tokens: 19_400_000 },
      },
      "billing-api": {
        today: { cost: 1.8, tokens: 600_000 },
        total: { cost: 12.5, tokens: 4_100_000 },
      },
    },
    tasks: {
      tsk_rate: { cost: 0.42, tokens: 184_000 },
      tsk_round: { cost: 1.8, tokens: 600_000 },
    },
    today: { cost: 3.88, tokens: 1_379_000 },
  },
};

export const emptySnapshot: DashboardSnapshot = {
  editors: [],
  nodes: [nodes[0]],
  preflight: { errors: [] },
  projects: [],
  roots: ["/home/dev/code"],
};

export const preflightSnapshot: DashboardSnapshot = {
  ...emptySnapshot,
  preflight: {
    errors: [
      "docker is not running: Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
      "devcontainer CLI not found on PATH (npm i -g @devcontainers/cli)",
    ],
  },
};

const pad = (v: number): string => String(v).padStart(2, "0");
const localDay = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const USAGE_DAYS = 30;

export const usageReport: UsageReport = {
  day: localDay(now),
  dayTotal: { cost: 3.88, tokens: 1_379_000 },
  days: Array.from({ length: USAGE_DAYS }, (_, i) => {
    const offset = USAGE_DAYS - 1 - i;
    const weekend = new Date(ago(offset * DAY)).getDay() % 6 === 0;
    let cost = weekend
      ? 0
      : Math.round((2 + Math.sin(i / 3) * 1.5 + (i % 5)) * 100) / 100;
    // Today's bar matches the "Today" total.
    if (offset === 0) {
      cost = 3.88;
    }
    return {
      cost,
      day: localDay(ago(offset * DAY)),
      tokens: Math.round(cost * 350_000),
    };
  }),
  projects: [
    { cost: 2.08, projectId: "acme-web", tokens: 779_000 },
    { cost: 1.8, projectId: "billing-api", tokens: 600_000 },
  ],
  today: { cost: 3.88, tokens: 1_379_000 },
  total: { cost: 60.62, tokens: 23_500_000 },
};

export const models: ModelsInfo = {
  agents: [
    { description: "Writes and edits code", id: "build", name: "Build" },
    { description: "Read-only planning", id: "plan", name: "Plan" },
  ],
  default: { id: "claude-opus-5-5", providerID: "anthropic" },
  models: [
    {
      id: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      providerID: "anthropic",
      variants: ["default", "high"],
    },
    {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      providerID: "anthropic",
      variants: ["default"],
    },
    {
      id: "gpt-6",
      name: "GPT-6",
      providerID: "openai",
      variants: ["default", "high"],
    },
  ],
};

/** The branch checked out at `directory`, per the snapshot's worktrees; the main checkouts are on main. */
const branchAt = (directory: string): string =>
  snapshot.projects
    .flatMap((v) => v.runtime.worktrees ?? [])
    .find((w) => w.path === directory)?.branch ?? "main";

/** A stand-in for a changed image: requests per minute before and after the limit, or the old and new logo. */
export const reviewImage = (file: string, old: boolean): string => {
  if (file.endsWith("logo.png")) {
    const color = old ? "#64748b" : "#7c3aed";
    return `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160"><rect x="${old ? 20 : 30}" y="${old ? 20 : 30}" width="${old ? 120 : 100}" height="${old ? 120 : 100}" rx="${old ? 12 : 50}" fill="${color}"/><text x="80" y="92" font-family="sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">odh</text></svg>`;
  }
  const bars = [12, 18, 35, 64, 20, 20, 20, 19, 20, 14]
    .map(
      (v, i) =>
        `<rect x="${24 + i * 34}" y="${180 - v * 2}" width="24" height="${v * 2}" rx="3" fill="${v > 20 ? "#dc2626" : "#16a34a"}"/>`
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="380" height="200" viewBox="0 0 380 200"><rect width="380" height="200" fill="#fff"/><line x1="16" y1="140" x2="364" y2="140" stroke="#94a3b8" stroke-dasharray="4 4"/>${bars}</svg>`;
};

export const reviewData = (directory: string): ReviewData => ({
  ahead: 2,
  base: { name: "main", source: "default" },
  behind: 1,
  branch: branchAt(directory),
  directory,
  dirty: true,
  files: [
    {
      additions: 4,
      deletions: 0,
      file: "src/server/rate-limit.ts",
      patch: RATE_LIMIT_PATCH,
      status: "modified",
    },
    {
      additions: 2,
      deletions: 0,
      file: "src/server/routes.ts",
      patch: ROUTES_PATCH,
      status: "modified",
    },
    {
      additions: 120,
      deletions: 0,
      binary: false,
      file: "test/server/rate-limit.test.ts",
      large: true,
      status: "added",
    },
    {
      additions: 0,
      deletions: 0,
      binary: true,
      file: "docs/rate-limit.png",
      status: "added",
    },
    {
      additions: 0,
      deletions: 0,
      binary: true,
      file: "public/logo.png",
      status: "modified",
    },
  ],
  mode: "branch",
  pushed: false,
  workspace: { branch: "main", clean: true },
});

/** Recent prompts of the rate-limit worktree's session, newest first. */
const RATE_LIMIT_PROMPTS = [
  {
    created: ago(4 * MINUTE),
    id: "msg_03",
    text: "Also register the limiter on the login route",
  },
  {
    created: ago(25 * MINUTE),
    id: "msg_02",
    text: "Add a burst allowance to the login rate limiter",
  },
  {
    created: ago(70 * MINUTE),
    id: "msg_01",
    text: "Read the rate limiter and explain how it counts requests",
  },
];

/** What a session's turn changed: the newest one by default, nothing for the first (read-only) turn. */
export const turnReviewData = (
  directory: string,
  from?: string
): ReviewData => {
  const session = webSessions.find((s) => s.directory === directory);
  const base = reviewData(directory);
  if (!session) {
    return { ...base, mode: "working" };
  }
  const shown = from ?? RATE_LIMIT_PROMPTS[0].id;
  const files: Record<string, ReviewData["files"]> = {
    msg_01: [],
    msg_02: base.files.slice(0, 1),
    msg_03: base.files.slice(1, 2),
  };
  return {
    ...base,
    files: files[shown] ?? [],
    mode: "turn",
    turn: {
      from: shown,
      latest: shown === RATE_LIMIT_PROMPTS[0].id,
      prompts: RATE_LIMIT_PROMPTS,
      running: session.status !== "idle",
      sessionId: session.id,
      sessionTitle: session.title,
    },
  };
};

/** The rate-limit worktree's session: three turns, the newest waiting on a permission, and one subagent. */
export const sessionDetail = (sessionId: string): SessionDetail | undefined => {
  const session = webSessions.find((s) => s.id === sessionId);
  if (!session) {
    return undefined;
  }
  const { model } = session;
  return {
    agent: "build",
    contextLimit: 200_000,
    createdAt: ago(75 * MINUTE),
    more: false,
    outcome: "succeeded",
    session,
    subagents: [
      {
        agent: "explore",
        cost: 0.04,
        id: "ses_sub01",
        title: "Find where requests are counted",
        tokens: 22_000,
        updatedAt: ago(68 * MINUTE),
      },
    ],
    tokens: {
      cacheRead: 98_000,
      cacheWrite: 12_000,
      input: 41_000,
      output: 8400,
      reasoning: 2600,
    },
    turns: [
      {
        agent: "build",
        cost: 0.11,
        created: RATE_LIMIT_PROMPTS[0].created,
        failedTools: 0,
        files: 1,
        id: RATE_LIMIT_PROMPTS[0].id,
        model,
        prompt: RATE_LIMIT_PROMPTS[0].text,
        reply:
          "Registered the limiter on POST /login. Running the rate-limit tests next.",
        steps: 3,
        tokens: 46_000,
        tools: 4,
      },
      {
        agent: "build",
        completed: RATE_LIMIT_PROMPTS[1].created + 6 * MINUTE,
        cost: 0.24,
        created: RATE_LIMIT_PROMPTS[1].created,
        failedTools: 1,
        files: 1,
        id: RATE_LIMIT_PROMPTS[1].id,
        model,
        prompt: `${RATE_LIMIT_PROMPTS[1].text}.\n\nKeep the steady rate at 10 requests a minute, allow bursts of up to 5 more, and make both configurable through the existing limiter options. Add tests for the burst, for running out of it and for the refill.`,
        reply:
          "Added a `burst` option to the token bucket (default 5) next to `perMinute`.\n\n- The bucket now starts full at `perMinute + burst`.\n- Refill stays at `perMinute`.\n- Three tests cover the burst, running out and the refill.",
        steps: 7,
        tokens: 104_000,
        tools: 11,
      },
      {
        agent: "build",
        completed: RATE_LIMIT_PROMPTS[2].created + 2 * MINUTE,
        cost: 0.07,
        created: RATE_LIMIT_PROMPTS[2].created,
        failedTools: 0,
        files: 0,
        id: RATE_LIMIT_PROMPTS[2].id,
        model,
        prompt: RATE_LIMIT_PROMPTS[2].text,
        reply:
          "The limiter is a token bucket per IP: each request takes a token and tokens refill at `perMinute`.",
        steps: 2,
        tokens: 34_000,
        tools: 3,
      },
    ],
  };
};

/** A spec-first task's change, as `openspec` reports it in the task's worktree. */
export const specView: SpecView = {
  change: {
    artifacts: [
      { id: "proposal", outputPath: "proposal.md", status: "done" },
      { id: "design", outputPath: "design.md", status: "done" },
      { id: "specs", outputPath: "specs/**/*.md", status: "done" },
      { id: "tasks", outputPath: "tasks.md", status: "done" },
    ],
    documents: [
      {
        content:
          "## Why\n\nA script can try passwords against `/login` as fast as it likes.\n\n## What Changes\n\n- Limit login attempts to **5 per minute** per IP and account\n- Answer over-limit attempts with `429` and `Retry-After`\n\n## Impact\n\n- `src/server/rate-limit.ts`, `src/server/routes.ts`",
        path: "proposal.md",
      },
      {
        content:
          "## Context\n\nThe limiter keeps hits in memory per key.\n\n## Decisions\n\n- A sliding window per IP **and** per account, so one IP can't spread guesses across accounts.",
        path: "design.md",
      },
      {
        content:
          "## 1. Limiter\n\n- [x] 1.1 Add a burst window to `RateLimiter`\n- [ ] 1.2 Prune old hits for other keys\n\n## 2. Login route\n\n- [ ] 2.1 Apply the limiter to `/login`\n- [ ] 2.2 Send `Retry-After`",
        path: "tasks.md",
      },
      {
        content:
          "## ADDED Requirements\n\n### Requirement: Login attempt limit\nThe system SHALL reject more than 5 login attempts per minute from one IP or for one account with `429`.\n\n#### Scenario: Burst from one IP\n- **WHEN** an IP sends a 6th attempt within a minute\n- **THEN** the response is `429` with `Retry-After`\n\n## MODIFIED Requirements\n\n### Requirement: Failed login response\nThe system SHALL answer a failed login with `401` after 1 second, and count it towards the attempt limit.\n\n#### Scenario: Wrong password\n- **WHEN** the password is wrong\n- **THEN** the response is `401`\n- **AND** the attempt counts towards the limit\n\n## REMOVED Requirements\n\n### Requirement: Captcha after failures\n**Reason**: The attempt limit replaces it.\n**Migration**: None.\n",
        path: "specs/auth/spec.md",
      },
    ],
    name: "add-login-burst-limit",
    planningComplete: true,
    requirements: [
      {
        capability: "auth",
        delta:
          "### Requirement: Login attempt limit\nThe system SHALL reject more than 5 login attempts per minute from one IP or for one account with `429`.\n\n#### Scenario: Burst from one IP\n- **WHEN** an IP sends a 6th attempt within a minute\n- **THEN** the response is `429` with `Retry-After`",
        name: "Login attempt limit",
        operation: "ADDED",
      },
      {
        before:
          "### Requirement: Failed login response\nThe system SHALL answer a failed login with `401` after 1 second.\n\n#### Scenario: Wrong password\n- **WHEN** the password is wrong\n- **THEN** the response is `401`",
        capability: "auth",
        delta:
          "### Requirement: Failed login response\nThe system SHALL answer a failed login with `401` after 1 second, and count it towards the attempt limit.\n\n#### Scenario: Wrong password\n- **WHEN** the password is wrong\n- **THEN** the response is `401`\n- **AND** the attempt counts towards the limit",
        name: "Failed login response",
        operation: "MODIFIED",
      },
      {
        before:
          "### Requirement: Captcha after failures\nThe system SHALL ask for a captcha after 3 failed logins.",
        capability: "auth",
        delta:
          "### Requirement: Captcha after failures\n**Reason**: The attempt limit replaces it.\n**Migration**: None.",
        name: "Captcha after failures",
        operation: "REMOVED",
      },
    ],
    validation: { issues: [], valid: true },
  },
  changes: [
    {
      completedTasks: 1,
      isNew: true,
      lastModified: "2026-10-09T09:12:00Z",
      name: "add-login-burst-limit",
      totalTasks: 4,
    },
    {
      completedTasks: 0,
      isNew: false,
      lastModified: "2026-09-30T14:00:00Z",
      name: "add-sso",
      totalTasks: 7,
    },
  ],
};

export const checksView: ChecksView = {
  checks: [
    {
      approved: true,
      command: "pnpm typecheck",
      name: "typecheck",
      timeout: 300,
      where: "container",
    },
    {
      approved: true,
      command: "pnpm test",
      name: "test",
      timeout: 600,
      where: "container",
    },
    {
      approved: false,
      command: "pnpm exec ultracite check",
      name: "lint",
      timeout: 120,
      where: "host",
    },
  ],
  current: true,
  devcontainer: [
    {
      command: "pnpm typecheck",
      name: "typecheck",
      timeout: 300,
      where: "container",
    },
    { command: "pnpm test", name: "test", timeout: 600, where: "container" },
    {
      command: "pnpm exec ultracite check",
      name: "lint",
      timeout: 120,
      where: "host",
    },
  ],
  errors: [],
  run: {
    dirty: false,
    directory: WEB_WORKTREE,
    finishedAt: ago(4 * MINUTE),
    head: "7c9d2f4",
    results: [
      {
        command: "pnpm typecheck",
        durationMs: 8400,
        exitCode: 0,
        name: "typecheck",
        output: [],
        status: "passed",
        where: "container",
      },
      {
        command: "pnpm test",
        durationMs: 21_300,
        exitCode: 1,
        name: "test",
        output: [
          " FAIL  test/server/rate-limit.test.ts > rejects bursts",
          "AssertionError: expected true to be false",
          " Tests  1 failed | 41 passed (42)",
        ],
        status: "failed",
        where: "container",
      },
      {
        command: "pnpm exec ultracite check",
        name: "lint",
        output: [],
        reason: "Host command not approved",
        status: "error",
        where: "host",
      },
    ],
    startedAt: ago(5 * MINUTE),
  },
  source: "devcontainer",
};

export const publishInfo: PublishInfo = {
  branch: "feat/rate-limit",
  forge: { kind: "forgejo", webBase: "https://git.acme.dev/acme/web" },
  pushFrom: "host",
  remote: "origin",
  remotes: ["origin", "upstream"],
  strategies: ["branch", "agit"],
  strategy: "branch",
};

export const candidates: CandidateList = {
  candidates: [
    {
      name: "design-system",
      path: "/home/dev/code/design-system",
      root: "/home/dev/code",
      stack: "node",
    },
    {
      name: "etl-jobs",
      path: "/home/dev/code/etl-jobs",
      root: "/home/dev/code",
      stack: "python",
    },
    {
      name: "edge-proxy",
      path: "/home/dev/code/edge-proxy",
      root: "/home/dev/code",
      stack: "rust",
    },
  ],
  roots: ["/home/dev/code"],
};

export const cleanupPlan: CleanupPlan = {
  items: [
    {
      base: "main",
      branch: "feat/old-banner",
      checked: true,
      id: "branch:acme-web:feat/old-banner",
      kind: "branch",
      projectId: "acme-web",
      reason: "merged into main",
      why: "merged",
      worktree: "/workspaces/.worktrees/acme-web/old-banner",
    },
    {
      base: "main",
      branch: "spike/graphql",
      checked: false,
      dirty: true,
      id: "branch:acme-web:spike/graphql",
      kind: "branch",
      projectId: "acme-web",
      reason: "upstream branch is gone",
      why: "upstream-gone",
      worktree: "/workspaces/.worktrees/acme-web/graphql",
    },
    {
      checked: true,
      containerId: "deadbeef0001",
      id: "container:deadbeef0001",
      kind: "container",
      name: "opendevhub-acme-web-old-banner",
      reason: "its worktree is gone",
      running: false,
      why: "orphan-env",
    },
    {
      bytes: 3.2 * GIB,
      checked: true,
      id: "image:opendevhub/acme-web:0a1b2c",
      kind: "image",
      reason: "superseded by a newer build",
      ref: "opendevhub/acme-web:0a1b2c",
      why: "superseded",
    },
    {
      checked: true,
      directory: "/workspaces/.worktrees/acme-web/old-banner",
      id: "session:acme-web:ses_old01",
      kind: "session",
      projectId: "acme-web",
      reason: "discarded variant",
      sessionId: "ses_old01",
      title: "Old promo banner",
      updatedAt: ago(9 * DAY),
      why: "discarded",
    },
  ],
  projects: [
    { id: "acme-web", name: "acme-web" },
    {
      id: "billing-api",
      name: "billing-api",
      warning: "using local refs: fetch failed",
    },
    { id: "legacy-cms", name: "legacy-cms", skipped: "not running" },
  ],
  scannedAt: now,
};

export const integrationOff: ForgejoSettings = {
  enabled: false,
  hasToken: false,
  url: "",
};

export const forgejoSettings: ForgejoSettings = {
  enabled: true,
  hasToken: true,
  url: "https://git.acme.dev",
};

export const jiraSettings: JiraSettings = {
  enabled: true,
  hasToken: true,
  url: "https://acme.atlassian.net",
};

const pull = (
  number: number,
  title: string,
  extra: Partial<ForgejoPullRequest> = {}
): ForgejoPullRequest => ({
  number,
  owner: "acme",
  repo: "web",
  state: "open",
  title,
  updatedAt: isoAgo(number * HOUR),
  url: `https://git.acme.dev/acme/web/pulls/${number}`,
  ...extra,
});

export const forgejoPulls: ForgejoPullRequest[] = [
  pull(42, "Add burst limit to the login rate limiter"),
  pull(43, "Rate limit: expose metrics", {
    stack: {
      base: "feat/rate-limit",
      parent: {
        number: 42,
        title: "Add burst limit to the login rate limiter",
      },
    },
  }),
  pull(38, "Dark mode toggle in settings"),
  pull(31, "Fix invoice rounding for JPY", {
    repo: "billing",
    url: "https://git.acme.dev/acme/billing/pulls/31",
  }),
  pull(12, "Bump hono to 4.13", { state: "merged" }),
];

export const forgejoDetails: ForgejoPullDetails = {
  author: "tim",
  base: "main",
  body: "Limits each client to **20 requests** in a burst, on top of the per-minute limit.\n\n- [x] Unit tests\n- [ ] Docs\n\nCloses ACME-118.",
  draft: false,
  head: "feat/rate-limit",
  headSha: "7c9d2f4e1b0a9c8d7e6f5a4b3c2d1e0f9a8b7c6d",
  labels: ["security", "backend"],
  mergeable: true,
  pull: forgejoPulls[0],
  reviewers: ["alex", "sam"],
  stack: {
    ancestors: [],
    descendants: [
      {
        base: "feat/rate-limit",
        children: [],
        head: "feat/rate-limit-metrics",
        number: 43,
        title: "Rate limit: expose metrics",
      },
    ],
  },
};

/** Where each pull request stands: #42 has a change request, #38 is approved, the rest wait on reviews. */
export const forgejoApprovals = (number: number): ForgejoApprovals => {
  if (number === 42) {
    return {
      approvedBy: ["alex"],
      base: "main",
      changesRequestedBy: ["sam"],
      required: 2,
    };
  }
  if (number === 38) {
    return {
      approvedBy: ["alex", "sam"],
      base: "main",
      changesRequestedBy: [],
      required: 2,
    };
  }
  return { approvedBy: [], base: "main", changesRequestedBy: [], required: 1 };
};

export const forgejoComments: ForgejoComment[] = [
  {
    author: "alex",
    body: "Nice, this has bitten us twice in prod.",
    id: 1,
    updatedAt: isoAgo(3 * HOUR),
  },
  {
    author: "sam",
    body: "Should `MAX_BURST` be configurable per route?",
    id: 2,
    updatedAt: isoAgo(2 * HOUR),
  },
];

export const forgejoReviews: ForgejoReview[] = [
  {
    author: "alex",
    body: "LGTM",
    commentsCount: 0,
    commit: forgejoDetails.headSha,
    dismissed: false,
    id: 10,
    official: true,
    stale: false,
    state: "APPROVED",
    submittedAt: isoAgo(2 * HOUR),
  },
  {
    author: "sam",
    body: "One question about the burst constant.",
    commentsCount: 1,
    commit: forgejoDetails.headSha,
    dismissed: false,
    id: 11,
    official: true,
    stale: false,
    state: "REQUEST_CHANGES",
    submittedAt: isoAgo(HOUR),
  },
];

export const forgejoReviewComments: ForgejoComment[] = [
  {
    author: "sam",
    body: "Magic number — pull it from config?",
    diffHunk:
      "@@ -1,12 +1,16 @@\n const WINDOW_MS = 60_000;\n+const MAX_BURST = 20;",
    id: 101,
    line: 2,
    path: "src/server/rate-limit.ts",
    updatedAt: isoAgo(HOUR),
  },
];

export const forgejoChecks: ForgejoChecks = {
  items: [
    {
      description: "Successful in 1m12s",
      id: 1,
      name: "ci / typecheck",
      status: "success",
    },
    {
      description: "Failing after 2m3s",
      id: 2,
      name: "ci / test",
      status: "failure",
      url: "https://git.acme.dev/acme/web/actions/runs/88",
    },
    {
      description: "Waiting to run",
      id: 3,
      name: "ci / e2e",
      status: "pending",
    },
  ],
  sha: forgejoDetails.headSha,
  state: "failure",
};

const ticket = (
  key: string,
  title: string,
  extra: Partial<JiraTicketSummary> = {}
): JiraTicketSummary => ({
  assignee: "Tim Richter",
  key,
  priority: "Medium",
  status: "In Progress",
  statusCategory: "indeterminate",
  statusId: "3",
  title,
  type: "Story",
  updatedAt: isoAgo(DAY),
  url: `https://acme.atlassian.net/browse/${key}`,
  ...extra,
});

export const jiraTickets: JiraTicketSummary[] = [
  ticket("ACME-118", "Login endpoint needs burst protection", {
    priority: "High",
    type: "Bug",
  }),
  ticket("ACME-121", "Dark mode for the settings page"),
  ticket("ACME-97", "Full-text search in docs", {
    status: "To Do",
    statusCategory: "new",
    statusId: "1",
    assignee: undefined,
  }),
  ticket("ACME-90", "Rotate the staging TLS certificates", {
    status: "In Review",
    statusId: "10001",
  }),
  ticket("ACME-84", "Paginate the audit log", {
    status: "Done",
    statusCategory: "done",
    statusId: "10002",
  }),
  ticket("BILL-31", "JPY invoices are off by one yen", {
    priority: "Highest",
    type: "Bug",
  }),
];

export const jiraCatalog: JiraCatalog = {
  boards: [
    { id: 1, name: "ACME Sprint Board", project: "ACME", type: "scrum" },
    { id: 2, name: "Billing Kanban", project: "BILL", type: "kanban" },
  ],
  filters: [
    { id: 10_100, name: "Security bugs" },
    { id: 10_101, name: "Release blockers" },
  ],
  projects: [
    { key: "ACME", name: "Acme Platform" },
    { key: "BILL", name: "Billing" },
  ],
};

export const jiraBoardColumns: JiraBoardColumn[] = [
  { name: "Backlog", statusIds: [] },
  { name: "To Do", statusIds: ["1"] },
  { name: "In Progress", statusIds: ["3"] },
  { name: "Done", statusIds: ["10002"] },
];

export const jiraTicket = (key: string): JiraTicket => {
  const summary =
    jiraTickets.find((t) => t.key === key) ?? ticket(key, "Mock ticket");
  return {
    ...summary,
    createdAt: isoAgo(7 * DAY),
    description:
      "Attackers can hammer `/login` within the per-minute window.\n\n## Acceptance criteria\n\n- Bursts above 20 req/s are rejected with 429\n- Limit is covered by tests",
    instanceUrl: "https://acme.atlassian.net",
    labels: ["security"],
    project: summary.key.split("-")[0],
    reporter: "Alex Kim",
  };
};

export const logLines: string[] = [
  "[devcontainer] Starting container opendevhub-acme-web",
  "[devcontainer] Container started (abc123def456)",
  "[opencode] Listening on 0.0.0.0:4096",
  "[ports] Forwarded 3000 -> 43000 (api)",
  "[ports] Forwarded 5173 -> 45173 (web)",
  "[ports] 9229: port in use",
];

/** What opendevhub links to PR #42: tsk_rate made it, it is checked out once, and an AI review ran on it twice. */
export const pullLinks = (url: string): PullLinks =>
  url === RATE_LIMIT_PR.url
    ? {
        branches: [
          {
            id: 1,
            name: "feat/rate-limit",
            projectId: "acme-web",
            role: "head",
            task: {
              id: "tsk_rate",
              n: 1,
              title: "Add burst limit to the login rate limiter",
            },
            worktrees: [{ path: WEB_WORKTREE }],
          },
        ],
        id: 7,
        pull: RATE_LIMIT_PR,
        reviewTasks: [
          {
            createdAt: ago(2 * HOUR),
            id: "tsk_review42",
            projectId: "acme-web",
            title:
              "AI review: PR #42 Add burst limit to the login rate limiter",
          },
        ],
        reviews: [
          {
            createdAt: ago(90 * MINUTE),
            findings: [
              {
                body: "`limit` is created but never applied to `/login`.",
                file: "src/server/routes.ts",
                line: 11,
                severity: "blocker",
                side: "new",
              },
            ],
            headSha: forgejoDetails.headSha,
            id: 2,
            mode: "session",
            sessionId: "ses_ai00",
            summary: "The limiter is never wired into the login route.",
            taskId: "tsk_review42",
          },
          {
            createdAt: ago(DAY),
            findings: [
              {
                body: "Consider documenting the 429 behaviour.",
                severity: "nit",
              },
            ],
            headSha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
            id: 1,
            mode: "quick",
            summary: "Looks reasonable; one doc nit.",
          },
        ],
      }
    : { branches: [], reviewTasks: [], reviews: [] };

/** The tasks started from ACME-118: tsk_rate, published as PR #42. */
export const ticketLinks = (key: string): TicketLinks =>
  key === ACME_118.key
    ? {
        id: 3,
        tasks: [
          {
            createdAt: ago(40 * MINUTE),
            id: "tsk_rate",
            projectId: "acme-web",
            pullRequests: [{ ...RATE_LIMIT_PR, variant: 1 }],
            state: "running",
            title: "Add burst limit to the login rate limiter",
          },
        ],
        ticket: ACME_118,
      }
    : { tasks: [] };

const RATE_TASK = "Add burst limit to the login rate limiter";

/** What happened in the fixtures' projects, newest first: one of every kind worth showing. */
export const activityEvents: ActivityEvent[] = (
  [
    [
      14,
      4 * MINUTE,
      { type: "variant", id: "tsk_search/1" },
      "branch.created",
      { type: "branch", id: "5" },
      { createdBy: "variant", name: "feat/search-1" },
      "tsk_search",
    ],
    [
      13,
      5 * MINUTE,
      { type: "user" },
      "task.started",
      { type: "task", id: "tsk_search" },
      { kind: "task", title: "Add full-text search to the docs", variants: 2 },
      "tsk_search",
    ],
    [
      12,
      9 * MINUTE,
      { type: "variant", id: "tsk_search/2" },
      "variant.failed",
      { type: "variant", id: "tsk_search/2" },
      { error: "image build failed: npm ci exited 1" },
      "tsk_search",
    ],
    [
      11,
      20 * MINUTE,
      { type: "user" },
      "branch.published",
      { type: "branch", id: "1" },
      { name: "feat/rate-limit", remote: "origin" },
      "tsk_rate",
    ],
    [
      10,
      20 * MINUTE,
      { type: "user" },
      "pull_request.linked",
      { type: "pull_request", id: "7" },
      { branch: "feat/rate-limit", role: "head", url: RATE_LIMIT_PR.url },
      "tsk_rate",
    ],
    [
      9,
      90 * MINUTE,
      { type: "user" },
      "review.run",
      { type: "review", id: "2" },
      { findings: 1, mode: "session", url: RATE_LIMIT_PR.url },
      "tsk_review42",
    ],
    [
      8,
      2 * HOUR,
      { type: "system" },
      "worktree.adopted",
      { type: "worktree", id: "2" },
      { branch: "feat/dark-mode", path: WEB_ISOLATED_WORKTREE },
      undefined,
    ],
    [
      7,
      2 * HOUR,
      { type: "system" },
      "session.adopted",
      { type: "session", id: "ses_run01" },
      { variant: 1 },
      "tsk_dark",
    ],
    [
      6,
      40 * MINUTE,
      { type: "variant", id: "tsk_rate/1" },
      "session.started",
      { type: "session", id: "ses_perm01" },
      { variant: 1 },
      "tsk_rate",
    ],
    [
      5,
      40 * MINUTE,
      { type: "variant", id: "tsk_rate/1" },
      "worktree.created",
      { type: "worktree", id: "1" },
      { branch: "feat/rate-limit", path: WEB_WORKTREE },
      "tsk_rate",
    ],
    [
      4,
      40 * MINUTE,
      { type: "user" },
      "ticket.linked",
      { type: "ticket", id: "3" },
      { key: ACME_118.key, url: ACME_118.url },
      "tsk_rate",
    ],
    [
      3,
      40 * MINUTE,
      { type: "user" },
      "task.started",
      { type: "task", id: "tsk_rate" },
      { kind: "task", title: RATE_TASK, variants: 1 },
      "tsk_rate",
    ],
    [
      2,
      3 * HOUR,
      { type: "system" },
      "session.removed",
      { type: "session", id: "ses_gone01" },
      { variant: 1 },
      "tsk_old",
    ],
    [
      1,
      DAY,
      { type: "system" },
      "project.discovered",
      { type: "project", id: "acme-web" },
      { name: "acme-web", path: "/home/dev/code/acme-web" },
      undefined,
    ],
  ] as const
).map(([id, age, actor, verb, object, data, taskId]): ActivityEvent => {
  const project = "acme-web";
  const title = taskId
    ? webProject.tasks.find((t) => t.id === taskId)?.title
    : undefined;
  return {
    actor,
    at: ago(age),
    data,
    id,
    object,
    projectId: project,
    projectName: "acme-web",
    verb,
    ...(taskId ? { taskId } : {}),
    ...(title ? { taskTitle: title } : {}),
  };
});

/** `GET /api/activity` over the fixture events. */
export const activityPage = (query: URLSearchParams): ActivityPage => {
  const limit = Number(query.get("limit") ?? 50);
  const before = query.get("before");
  const project = query.get("project");
  const task = query.get("task");
  const entity = query.get("entity");
  const matching = activityEvents.filter(
    (e) =>
      (!before || e.id < Number(before)) &&
      (!project || e.projectId === project) &&
      (!task || e.taskId === task) &&
      (!entity || `${e.object.type}:${e.object.id}` === entity)
  );
  const events = matching.slice(0, limit);
  const last = events.at(-1);
  return {
    events,
    ...(matching.length > limit && last ? { next: last.id } : {}),
  };
};

const base = "/p/acme-web";
const steps = {
  branch: {
    href: `${base}/w/rate-limit`,
    id: "1",
    label: "feat/rate-limit",
    type: "branch",
  },
  pull: {
    href: "/forgejo/acme/web/42",
    id: "7",
    label: "PR #42",
    type: "pull_request",
    url: RATE_LIMIT_PR.url,
  },
  review: {
    href: "/forgejo/acme/web/42",
    id: "2",
    label: "AI review · 1 finding",
    type: "review",
    url: RATE_LIMIT_PR.url,
  },
  session: {
    href: `${base}/w/rate-limit/s/ses_perm01`,
    id: "ses_perm01",
    label: "Session",
    type: "session",
  },
  task: {
    href: `${base}/t/tsk_rate`,
    id: "tsk_rate",
    label: RATE_TASK,
    type: "task",
  },
  ticket: {
    href: "/jira/ACME-118",
    id: "3",
    label: "ACME-118",
    type: "ticket",
    url: ACME_118.url,
  },
  variant: {
    href: `${base}/t/tsk_rate`,
    id: "tsk_rate/1",
    label: "Variant 1 (claude-opus-5-5)",
    type: "variant",
  },
  worktree: {
    href: `${base}/w/rate-limit`,
    id: "1",
    label: "rate-limit",
    type: "worktree",
  },
} satisfies Record<string, ProvenanceStep>;

/** A trail with a removed worktree and container, for the breadcrumb's stories. */
export const removedTrail: Provenance = {
  ledTo: [],
  trail: [
    steps.ticket,
    steps.task,
    steps.variant,
    { ...steps.branch, href: undefined },
    { id: "9", label: "rate-limit", removed: true, type: "worktree" },
    { id: "env-9", label: "Container", removed: true, type: "environment" },
  ],
};

/** `GET /api/provenance/:type/:id` for the fixtures' entities; undefined for any other. */
export const provenanceOf = (
  type: string,
  id: string
): Provenance | undefined => {
  const chain = [steps.ticket, steps.task, steps.variant, steps.branch];
  const ledTo = [steps.pull, steps.review];
  switch (`${type}:${id}`) {
    case "task:tsk_rate": {
      return { ledTo, trail: [steps.ticket, steps.task] };
    }
    case "session:ses_perm01": {
      return { ledTo, trail: [...chain, steps.worktree, steps.session] };
    }
    case "worktree:1": {
      return { ledTo, trail: [...chain, steps.worktree] };
    }
    case "worktree:2": {
      return {
        ledTo: [],
        trail: [
          { href: base, id: "acme-web", label: "acme-web", type: "project" },
          {
            href: `${base}/w/dark-mode`,
            id: "2",
            label: "dark-mode",
            type: "worktree",
            unmanaged: true,
          },
        ],
      };
    }
    case "pull_request:7": {
      return { ledTo: [steps.review], trail: [...chain, steps.pull] };
    }
    case "ticket:3": {
      return { ledTo: [steps.task, steps.pull], trail: [steps.ticket] };
    }
    default: {
      return undefined;
    }
  }
};

export const gitSetup: GitSetup = {
  agent: {
    keys: [
      {
        bits: 256,
        comment: "dev@laptop",
        fingerprint: "SHA256:q3Vb8m1PZ0kQd6T1sJr0R2mYxX4nF7aLwC9eHgUoK2s",
        type: "ED25519",
      },
    ],
    running: true,
  },
  hosts: [
    {
      host: "code.example.com",
      identityFiles: [
        {
          exists: true,
          inAgent: true,
          path: "/home/dev/.ssh/id_ed25519",
        },
      ],
      known: true,
      projects: ["acme-web", "acme-api"],
      user: "git",
    },
    {
      host: "[git.internal]:2222",
      identityFiles: [
        {
          exists: true,
          inAgent: false,
          path: "/home/dev/.ssh/work_rsa",
        },
      ],
      known: false,
      projects: ["billing"],
      user: "git",
    },
  ],
  identity: { email: "dev@example.com", name: "Dev Example" },
  keyFiles: [
    {
      bits: 256,
      comment: "dev@laptop",
      fingerprint: "SHA256:q3Vb8m1PZ0kQd6T1sJr0R2mYxX4nF7aLwC9eHgUoK2s",
      path: "/home/dev/.ssh/id_ed25519",
      type: "ED25519",
    },
    {
      bits: 4096,
      comment: "dev@work",
      fingerprint: "SHA256:Zk1m0pQ9rT2vX6yB8cD4eF7gH1jK3lM5nP7qR9sT0uV",
      path: "/home/dev/.ssh/work_rsa",
      type: "RSA",
    },
  ],
  projects: [
    {
      identity: { email: "dev@work.example", name: "Dev Example" },
      project: "billing",
      projectId: "billing",
    },
  ],
  signing: { enabled: true, format: "ssh", key: "~/.ssh/id_ed25519.pub" },
  version: "2.49.0",
};

/** A machine without git identity, agent or keys. */
export const gitSetupBare: GitSetup = {
  agent: {
    error: "Could not open a connection to your authentication agent.",
    keys: [],
    running: false,
  },
  hosts: [
    {
      host: "code.example.com",
      identityFiles: [],
      known: false,
      projects: ["acme-web"],
      user: "git",
    },
  ],
  identity: {},
  keyFiles: [],
  projects: [],
  signing: { enabled: false },
  version: "2.43.0",
};
