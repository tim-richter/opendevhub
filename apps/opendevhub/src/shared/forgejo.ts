export type {
  IntegrationSettings as ForgejoSettings,
  IntegrationSettingsInput as ForgejoSettingsInput,
} from "./integrations";

export type ForgejoPullFilter = "all" | "open" | "closed";
export type ForgejoInbox =
  | "authored"
  | "review-requested"
  | "assigned"
  | "review";

export interface ForgejoPullQuery {
  state?: ForgejoPullFilter;
  inbox?: ForgejoInbox;
  q?: string;
  repository?: string;
  /** Organization (or user) that owns the repositories. */
  org?: string;
  /** Team name within `org`: only repositories the team can access. */
  team?: string;
  page?: number;
}

export interface ForgejoOrganizations {
  orgs: string[];
}

export interface ForgejoTeams {
  teams: string[];
}

export interface ForgejoPullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  state: "open" | "closed" | "merged";
  /** Inbox only: set on an open pull request that targets another branch than its repository's default. */
  stack?: ForgejoStack;
}

export interface ForgejoStack {
  base: string;
  /** The open pull request in the same repository whose head branch is this one's base. */
  parent?: { number: number; title: string };
}

export interface ForgejoPulls {
  username: string;
  pulls: ForgejoPullRequest[];
  nextPage?: number;
}

export interface ForgejoPullDetails {
  pull: ForgejoPullRequest;
  body: string;
  author: string;
  base: string;
  head: string;
  headSha: string;
  headRepository?: string;
  draft: boolean;
  mergeable?: boolean;
  labels: string[];
  reviewers: string[];
  /** Set when open pull requests in the same repository build on this one or it builds on them. */
  stack?: ForgejoPullStack;
}

export interface ForgejoStackPull {
  number: number;
  title: string;
  base: string;
  head: string;
}

export interface ForgejoStackNode extends ForgejoStackPull {
  children: ForgejoStackNode[];
}

export interface ForgejoPullStack {
  /** The open pull requests this one builds on, from the bottom of the stack up to its direct parent. */
  ancestors: ForgejoStackPull[];
  /** The open pull requests built on this one, each with those built on it. */
  descendants: ForgejoStackNode[];
}

export interface ForgejoComment {
  id: number;
  author: string;
  body: string;
  updatedAt: string;
  path?: string;
  line?: number;
  oldLine?: number;
  diffHunk?: string;
  resolved?: boolean;
}

export interface ForgejoReview {
  id: number;
  author: string;
  body: string;
  state: string;
  submittedAt: string;
  commit: string;
  dismissed: boolean;
  stale: boolean;
  commentsCount: number;
  /** Counts towards the base branch's required approvals; missing on Forgejo versions that don't say. */
  official?: boolean;
}

/** Where a pull request stands against its base branch's required approvals. */
export interface ForgejoApprovals {
  /** The branch the pull request merges into, whose protection sets `required`. */
  base: string;
  /** Approvals the base branch's protection requires; missing when the branch isn't protected. */
  required?: number;
  /** Reviewers whose latest review approves. */
  approvedBy: string[];
  /** Reviewers whose latest review requests changes. */
  changesRequestedBy: string[];
}

export interface ForgejoPage<T> {
  items: T[];
  nextPage?: number;
}

export interface ForgejoCheck {
  id: number;
  name: string;
  status: string;
  description: string;
  url?: string;
}

export interface ForgejoChecks extends ForgejoPage<ForgejoCheck> {
  state: string;
  sha: string;
}
export interface ForgejoConnection {
  username: string;
  version: string;
}

export interface ForgejoDiff {
  pull: ForgejoPullRequest;
  base: string;
  head: string;
  patch: string;
  commitId?: string;
}

export interface ForgejoReviewComment {
  path: string;
  body: string;
  old_position: number;
  new_position: number;
}
export interface ForgejoReviewInput {
  commitId: string;
  body: string;
  event: "COMMENT" | "APPROVED" | "REQUEST_CHANGES";
  comments: ForgejoReviewComment[];
}

export type AiSeverity = "blocker" | "major" | "minor" | "nit";

/** One point an AI review raised; without a file it is about the pull request as a whole. */
export interface AiFinding {
  file?: string;
  /** The last line it covers: in the new file, or in the old one for removed lines. */
  line?: number;
  side?: "new" | "old";
  /** The first line of a range on the same side; missing for a single line. */
  start?: number;
  severity: AiSeverity;
  body: string;
}

export interface AiReviewResult {
  /** The session the findings came from; it stays open to follow up in. */
  sessionId: string;
  summary: string;
  findings: AiFinding[];
}
