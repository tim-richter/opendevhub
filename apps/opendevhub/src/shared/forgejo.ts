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
  page?: number;
}

export interface ForgejoPullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
  state: "open" | "closed" | "merged";
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
