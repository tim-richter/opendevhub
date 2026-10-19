import { describe, expect, it, vi } from "vitest";

import { createDashboardApp } from "../../../src/server/dashboard-api";
import type { DashboardDeps } from "../../../src/server/dashboard-api";
import type { ReviewData } from "../../../src/shared/types";

const changed = {
  base: { name: "main", source: "config" },
  files: [{ file: "src/a.ts", status: "modified", additions: 1, deletions: 1 }],
  mode: "branch",
} as ReviewData;

const setup = (reviewData = changed) => {
  const review = vi.fn(async () => reviewData);
  const startInCheckout = vi.fn(async (..._args: unknown[]) => ({
    sessionId: "review-session",
  }));
  const generateIn = vi.fn(async (..._args: unknown[]) => ({
    sessionId: "review-session",
    text: '{"summary":"Check the guard","findings":[{"file":"src/a.ts","line":4,"body":"Missing guard","severity":"major"}]}',
  }));
  const reviewLocal = vi.fn(async () => ({
    findings: [],
    stats: { filesReviewed: 1, filesSkipped: 0, status: "success" },
    summary: "Looks good",
  }));
  const app = createDashboardApp({
    ...({} as DashboardDeps),
    hub: {
      reviews: { review },
      sessions: { generateIn, startInCheckout },
    } as unknown as DashboardDeps["hub"],
    ocr: { service: { reviewLocal } } as unknown as DashboardDeps["ocr"],
  });
  const post = (endpoint: string, body: object) =>
    app.request(`/api/projects/p/review/${endpoint}`, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  return { generateIn, post, review, reviewLocal, startInCheckout };
};

describe("local AI review routes", () => {
  it("starts an investigation of the selected comparison and collects findings", async () => {
    const { post, review, startInCheckout, generateIn } = setup();
    const response = await post("ai-session", {
      base: "main",
      directory: "/work/repo",
      mode: "branch",
      sessionId: "task-session",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      sessionId: "review-session",
    });
    expect(review).toHaveBeenCalledWith("p", "/work/repo", {
      base: "main",
      mode: "branch",
    });
    expect(startInCheckout.mock.calls[0]?.[3]).toContain(
      "all changes compared with main"
    );
    expect(startInCheckout.mock.calls[0]?.[4]).toBe("task-session");

    const findings = await post("ai-findings", {
      directory: "/work/repo",
      sessionId: "review-session",
    });
    expect(findings.status).toBe(200);
    expect(await findings.json()).toMatchObject({
      findings: [{ body: "Missing guard", file: "src/a.ts" }],
    });
    expect(generateIn.mock.calls[0]?.[3]).toMatchObject({
      sessionId: "review-session",
    });
  });

  it("runs OCR on the resolved branch base", async () => {
    const { post, reviewLocal } = setup();
    const response = await post("ocr", {
      base: "main",
      directory: "/work/repo",
      mode: "branch",
    });
    expect(response.status).toBe(200);
    expect(reviewLocal).toHaveBeenCalledWith({
      base: "main",
      directory: "/work/repo",
      mode: "branch",
      projectId: "p",
    });
  });
});
