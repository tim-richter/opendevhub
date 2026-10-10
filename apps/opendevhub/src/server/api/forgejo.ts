import { Hono } from "hono";
import type { Context } from "hono";

import type {
  AiReviewResult,
  ForgejoPullDetails,
  ForgejoPullRequest,
} from "../../shared/forgejo";
import type { StoredAiReview } from "../../shared/types";
import type { DashboardDeps } from "../dashboard-api";
import { USER } from "../db/events";
import { UnavailableError } from "../errors";
import { InvalidRequestError } from "../git/worktrees";
import {
  AI_REVIEW_TIMEOUT_MS,
  aiFindingsPrompt,
  aiQuickReviewPrompt,
  aiReviewPrompt,
  aiReviewTitle,
  parseAiReview,
} from "../integrations/ai-review";
import { ForgejoError } from "../integrations/forgejo";
import { errorStatus, imageResponse, json, param, str } from "./helpers";
import { bodies, queries, validateJson, validateQuery } from "./validation";

/** What the forge says about a pull request, as a snapshot for its row. */
const pullFacts = (pull: ForgejoPullRequest) => ({
  forge: "forgejo" as const,
  number: pull.number,
  owner: pull.owner,
  repo: pull.repo,
  state: pull.state,
  title: pull.title,
  url: pull.url,
});

const detailFacts = (details: ForgejoPullDetails) => ({
  ...pullFacts(details.pull),
  baseBranch: details.base,
  headBranch: details.head,
});

export const createForgejoRoutes = (deps: DashboardDeps) => {
  const { hub, links } = deps;
  /** Refreshes the snapshot of the pull requests opendevhub knows; a failure never fails the request. */
  const refresh = (
    list: () => Parameters<NonNullable<typeof links>["refreshPulls"]>[0]
  ) => {
    try {
      links?.refreshPulls(list());
    } catch {
      // A stale snapshot is shown with when it was fetched.
    }
  };
  /** The row of a pull request opendevhub is about to review, with its snapshot. */
  const reviewedPull = (details: ForgejoPullDetails) => {
    const facts = detailFacts(details);
    const row = links?.ensurePull(facts.url, facts);
    refresh(() => [facts]);
    return row;
  };
  const requireForgejo = () => {
    if (!deps.forgejo) {
      throw new UnavailableError("Forgejo is not available");
    }
    return deps.forgejo;
  };
  const pullAt = async (c: Context, commitId: unknown) => {
    const details = await requireForgejo().details(
      param(c, "owner"),
      param(c, "repo"),
      param(c, "number")
    );
    if (!details.headSha || details.headSha !== commitId) {
      throw new ForgejoError(
        "The PR changed. Refresh it before starting an AI review."
      );
    }
    return details;
  };
  return new Hono()
    .use("/api/forgejo/*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .get("/api/forgejo/settings", (c) => json(c, () => requireForgejo().view()))
    .post("/api/forgejo/settings", validateJson(bodies.integration), (c) =>
      json(c, (_id) => {
        const b = c.req.valid("json");
        return requireForgejo().save(b);
      })
    )
    .post("/api/forgejo/test", validateJson(bodies.connection), (c) =>
      json(c, (_id) => {
        const b = c.req.valid("json");
        return requireForgejo().test(b, c.req.raw.signal);
      })
    )
    .get("/api/forgejo/pulls", validateQuery(queries.pulls), (c) =>
      json(c, async () => {
        const inbox = await requireForgejo().inbox(
          {
            inbox: c.req.valid("query").inbox ?? "authored",
            page: Number(c.req.valid("query").page ?? 1),
            org: c.req.valid("query").org,
            q: c.req.valid("query").q,
            repository: c.req.valid("query").repository,
            team: c.req.valid("query").team,
            state: c.req.valid("query").state ?? "all",
          },
          c.req.raw.signal
        );
        refresh(() => inbox.pulls.map(pullFacts));
        return inbox;
      })
    )
    .get("/api/forgejo/orgs", (c) =>
      json(c, () => {
        const forgejo = requireForgejo();
        if (!forgejo.organizations) {
          throw new UnavailableError("Forgejo organizations are not available");
        }
        return forgejo.organizations(c.req.raw.signal);
      })
    )
    .get("/api/forgejo/orgs/:org/teams", (c) =>
      json(c, () => {
        const forgejo = requireForgejo();
        if (!forgejo.teams) {
          throw new UnavailableError("Forgejo teams are not available");
        }
        return forgejo.teams(c.req.param("org"), c.req.raw.signal);
      })
    )
    .post(
      "/api/forgejo/pulls/:owner/:repo/:number/reviews",
      validateJson(bodies.forgejoReview),
      (c) =>
        json(c, (_id) => {
          const b = c.req.valid("json");
          const forgejo = requireForgejo();
          if (!forgejo.review) {
            throw new UnavailableError("Forgejo reviews are not available");
          }
          return forgejo.review(
            param(c, "owner"),
            param(c, "repo"),
            param(c, "number"),
            b
          );
        })
    )
    .post(
      "/api/forgejo/pulls/:owner/:repo/:number/ai-review/session",
      validateJson(bodies.aiReview),
      (c) =>
        json(c, async (_id) => {
          const b = c.req.valid("json");
          const details = await pullAt(c, b.commitId);
          const pull = reviewedPull(details);
          return {
            sessionId: await hub.sessions.startSession(
              str(b.projectId) ?? "",
              str(b.directory) ?? "",
              aiReviewTitle(details),
              aiReviewPrompt(details),
              pull ? { reviewOf: pull.id } : {}
            ),
          };
        })
    )
    .post(
      "/api/forgejo/pulls/:owner/:repo/:number/ai-review",
      validateJson(bodies.aiFindings),
      (c) =>
        json(c, async (_id): Promise<AiReviewResult> => {
          const b = c.req.valid("json");
          const details = await pullAt(c, b.commitId);
          const sessionId = str(b.sessionId);
          let prompt = aiFindingsPrompt();
          if (!sessionId) {
            const diff = await requireForgejo().patch(
              param(c, "owner"),
              param(c, "repo"),
              param(c, "number")
            );
            prompt = aiQuickReviewPrompt(details, diff.patch);
          }
          const pull = reviewedPull(details);
          const generated = await hub.sessions.generateIn(
            str(b.projectId) ?? "",
            str(b.directory) ?? "",
            prompt,
            {
              sessionId,
              timeoutMs: AI_REVIEW_TIMEOUT_MS,
              title: aiReviewTitle(details),
              ...(pull ? { reviewOf: pull.id } : {}),
            }
          );
          let review: ReturnType<typeof parseAiReview>;
          try {
            review = parseAiReview(generated.text);
          } catch (error) {
            throw new ForgejoError(
              error instanceof Error ? error.message : String(error),
              502
            );
          }
          if (pull && links) {
            links.insertReview(
              {
                findings: review.findings,
                headSha: details.headSha,
                mode: sessionId ? "session" : "quick",
                pullRequestId: pull.id,
                sessionId: generated.sessionId,
                summary: review.summary,
              },
              USER
            );
          }
          return { sessionId: generated.sessionId, ...review };
        })
    )
    .post(
      "/api/forgejo/pulls/:owner/:repo/:number/worktree",
      validateJson(bodies.forgejoWorktree),
      (c) =>
        json(c, async (_id) => {
          const b = c.req.valid("json");
          const diff = await requireForgejo().diff(
            param(c, "owner"),
            param(c, "repo"),
            param(c, "number")
          );
          if (diff.pull.state !== "open") {
            throw new ForgejoError("This pull request is no longer open.");
          }
          if (!diff.commitId || diff.commitId !== b.commitId) {
            throw new ForgejoError(
              "The PR changed. Refresh its diff before creating a worktree."
            );
          }
          return hub.checkouts.createWorktree(str(b.projectId) ?? "", {
            branch: str(b.branch) ?? "",
            pull: {
              commitId: diff.commitId ?? "",
              number: diff.pull.number,
              repo: { owner: diff.pull.owner, repo: diff.pull.repo },
              url: diff.pull.url,
            },
          });
        })
    )
    .get("/api/forgejo/pulls/:owner/:repo/:number", (c) =>
      json(c, async () => {
        const details = await requireForgejo().details(
          param(c, "owner"),
          param(c, "repo"),
          param(c, "number"),
          c.req.raw.signal
        );
        refresh(() => [detailFacts(details)]);
        return details;
      })
    )
    .get("/api/forgejo/pulls/:owner/:repo/:number/ai-reviews", (c) =>
      json(c, async (): Promise<{ reviews: StoredAiReview[] }> => {
        if (!links) {
          return { reviews: [] };
        }
        const forgejo = requireForgejo();
        const [owner, repo, number] = [
          param(c, "owner"),
          param(c, "repo"),
          param(c, "number"),
        ];
        if (forgejo.pullUrl) {
          return {
            reviews: links.reviewsOf(
              await forgejo.pullUrl(owner, repo, number)
            ),
          };
        }
        const details = await forgejo.details(
          owner,
          repo,
          number,
          c.req.raw.signal
        );
        return { reviews: links.reviewsOf(details.pull.url) };
      })
    )
    .get("/api/forgejo/pulls/:owner/:repo/:number/approvals", (c) =>
      json(c, () =>
        requireForgejo().approvals(
          param(c, "owner"),
          param(c, "repo"),
          param(c, "number"),
          c.req.raw.signal
        )
      )
    )
    .get(
      "/api/forgejo/pulls/:owner/:repo/:number/image",
      validateQuery(queries.forgejoImage),
      async (c) => {
        try {
          const { side } = c.req.valid("query");
          if (side !== "old" && side !== "new") {
            throw new InvalidRequestError(`unknown image side ${side}`);
          }
          const forgejo = requireForgejo();
          if (!forgejo.image) {
            throw new UnavailableError("Forgejo images are not available");
          }
          const image = await forgejo.image(
            param(c, "owner"),
            param(c, "repo"),
            param(c, "number"),
            c.req.valid("query").file ?? "",
            side,
            c.req.raw.signal
          );
          if (!image) {
            return c.json({ error: "no such version of the image" }, 404);
          }
          return imageResponse(c, image);
        } catch (error) {
          return c.json(
            { error: error instanceof Error ? error.message : String(error) },
            errorStatus(error)
          );
        }
      }
    )
    .get("/api/forgejo/pulls/:owner/:repo/:number/patch", (c) =>
      json(c, () =>
        requireForgejo().patch(
          param(c, "owner"),
          param(c, "repo"),
          param(c, "number"),
          c.req.raw.signal
        )
      )
    )
    .get(
      "/api/forgejo/pulls/:owner/:repo/:number/comments",
      validateQuery(queries.page),
      (c) =>
        json(c, () =>
          requireForgejo().comments(
            param(c, "owner"),
            param(c, "repo"),
            param(c, "number"),
            Number(c.req.valid("query").page ?? 1),
            c.req.raw.signal
          )
        )
    )
    .get(
      "/api/forgejo/pulls/:owner/:repo/:number/reviews",
      validateQuery(queries.page),
      (c) =>
        json(c, () =>
          requireForgejo().reviews(
            param(c, "owner"),
            param(c, "repo"),
            param(c, "number"),
            Number(c.req.valid("query").page ?? 1),
            c.req.raw.signal
          )
        )
    )
    .get(
      "/api/forgejo/pulls/:owner/:repo/:number/reviews/:review/comments",
      (c) =>
        json(c, () =>
          requireForgejo().reviewComments(
            param(c, "owner"),
            param(c, "repo"),
            param(c, "number"),
            param(c, "review"),
            c.req.raw.signal
          )
        )
    )
    .get(
      "/api/forgejo/checks/:owner/:repo/:sha",
      validateQuery(queries.page),
      (c) =>
        json(c, () =>
          requireForgejo().checks(
            param(c, "owner"),
            param(c, "repo"),
            param(c, "sha"),
            Number(c.req.valid("query").page ?? 1),
            c.req.raw.signal
          )
        )
    );
};
