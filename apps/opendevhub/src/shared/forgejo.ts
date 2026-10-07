/** Safe to return to the browser. The saved token never leaves the server. */
export interface ForgejoSettings {
  enabled: boolean;
  url: string;
  hasToken: boolean;
}

export interface ForgejoSettingsInput {
  enabled: boolean;
  url: string;
  /** Omit to keep the saved token. */
  token?: string;
  clearToken?: boolean;
}

export type ForgejoPullFilter = "all" | "open" | "closed";

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
