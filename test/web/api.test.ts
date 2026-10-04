import { afterEach, describe, expect, it, vi } from "vitest";
import { dismissForm, replyForm, replyPermission } from "../../src/web/api";

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("reply API", () => {
  it("posts a permission decision", async () => {
    const fetchMock = stubFetch(200, { ok: true });
    expect(await replyPermission("demo-1", "per/1", "reject", "no")).toBe("done");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/projects/demo-1/permissions/per%2F1");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ decision: "reject", message: "no" });
  });

  it("answers and dismisses forms", async () => {
    const fetchMock = stubFetch(200, { ok: true });
    await replyForm("p", "frm_1", { db: "pg" });
    await dismissForm("p", "frm_1");
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i?.method, i?.body])).toEqual([
      ["/api/projects/p/forms/frm_1", "POST", JSON.stringify({ answer: { db: "pg" } })],
      ["/api/projects/p/forms/frm_1", "DELETE", undefined],
    ]);
  });

  it("reports an item answered elsewhere as gone, not as an error", async () => {
    stubFetch(409, { error: "already answered" });
    expect(await replyPermission("p", "per_1", "once")).toBe("gone");
  });

  it("throws the server's message for other failures", async () => {
    stubFetch(400, { error: "db is required" });
    await expect(replyForm("p", "frm_1", {})).rejects.toThrow("db is required");
  });
});
