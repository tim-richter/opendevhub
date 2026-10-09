// Mock data for Storybook. Shapes follow src/shared; values describe a plausible day with two projects.
import type {
  ForgejoApprovals,
  ForgejoChecks,
  ForgejoComment,
  ForgejoPullDetails,
  ForgejoPullRequest,
  ForgejoReview,
  ForgejoSettings,
} from "../../shared/forgejo";
import type {
  JiraSettings,
  JiraTicket,
  JiraTicketSummary,
} from "../../shared/jira";
import type {
  CandidateList,
  ChecksView,
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
    task: {
      branch: "feat/rate-limit",
      task: "tsk_rate",
      title: "Add burst limit to the login rate limiter",
      variant: 1,
      of: 1,
    },
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
        head: "7c9d2f4",
        hostPath: "/home/dev/code/.worktrees/acme-web/rate-limit",
        path: WEB_WORKTREE,
      },
      {
        branch: "feat/dark-mode",
        head: "1a2b3c4",
        hostPath: "/home/dev/code/.worktrees/acme-web/dark-mode",
        path: WEB_ISOLATED_WORKTREE,
      },
    ],
  },
  sessions: webSessions,
  starting: [
    {
      createdAt: ago(MINUTE),
      of: 2,
      task: "tsk_search",
      title: "Add full-text search to the docs",
      variants: [
        {
          branch: "feat/search-1",
          log: [
            "Creating worktree feat/search-1",
            "Pulling image opendevhub/acme-web:4f1c2a",
          ],
          step: "image",
          variant: 1,
        },
        {
          branch: "feat/search-2",
          error: "docker: no space left on device",
          log: [
            "Creating worktree feat/search-2",
            "Starting container",
            "docker: no space left on device",
          ],
          step: "failed",
          variant: 2,
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
        head: "9f8e7d6",
        origin: "https://git.acme.dev/acme/billing/pulls/31",
        path: "/workspaces/.worktrees/billing-api/v1",
      },
      {
        branch: "fix/invoice-rounding-2",
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
    task: {
      branch: variant === 1 ? "fix/invoice-rounding" : "fix/invoice-rounding-2",
      task: "tsk_round",
      title: "Fix invoice rounding for JPY",
      variant,
      of: 2,
    },
    title: "Fix invoice rounding for JPY",
    tokens: 200_000 * variant,
    updatedAt: ago(variant * 20 * MINUTE),
  })),
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
    assignee: undefined,
  }),
  ticket("BILL-31", "JPY invoices are off by one yen", {
    priority: "Highest",
    type: "Bug",
  }),
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
