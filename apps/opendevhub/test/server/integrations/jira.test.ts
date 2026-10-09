import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileForgejoSettings } from "../../../src/server/integrations/forgejo";
import {
  FileJiraSettings,
  Jira,
  jiraUrl,
} from "../../../src/server/integrations/jira";
import { CredentialStoreError } from "../../../src/server/integrations/secrets";
import { MemorySecretStore } from "../../helpers/secrets";

let dir: string;
let secrets: MemorySecretStore;
let settings: FileJiraSettings;
const configured = {
  enabled: true,
  url: "https://jira.example.com/jira",
  token: "jira-secret",
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const issue = (key = "APP-1", fields: Record<string, unknown> = {}) => ({
  key,
  self: "https://attacker.example.com",
  fields: {
    summary: "Fix login",
    description: "Fails on Safari\nAcceptance: login succeeds",
    status: { name: "In Progress" },
    issuetype: { name: "Bug" },
    priority: { name: "High" },
    assignee: { displayName: "Alice" },
    project: { name: "App" },
    reporter: { displayName: "Bob" },
    labels: ["login"],
    created: "2026-10-01T12:00:00Z",
    updated: "2026-10-07T12:00:00Z",
    ...fields,
  },
});
const page = (issues = [issue()], total = issues.length, startAt = 0) => ({
  issues,
  total,
  startAt,
  maxResults: 50,
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-jira-"));
  secrets = new MemorySecretStore();
  settings = new FileJiraSettings(dir, secrets);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("protected Jira settings", () => {
  it("is opt-in, persists only a credential reference, and keeps Forgejo independent", async () => {
    await expect(settings.view()).resolves.toStrictEqual({
      enabled: false,
      url: "",
      hasToken: false,
    });
    await settings.save(configured);
    const forgejo = new FileForgejoSettings(dir, secrets);
    await forgejo.save({
      enabled: true,
      url: "https://forge.example.com",
      token: "forge-secret",
    });
    await expect(
      new FileJiraSettings(dir, secrets).read()
    ).resolves.toStrictEqual(configured);
    const file = path.join(dir, "integrations/jira.json");
    expect(fs.readFileSync(file, "utf-8")).not.toContain(configured.token);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.stringify(await settings.view())).not.toContain(
      configured.token
    );
    await settings.save({ enabled: false, url: configured.url });
    expect((await settings.read()).token).toBe(configured.token);
    await settings.save({ ...configured, token: "replacement" });
    expect([...secrets.values.values()].sort()).toStrictEqual([
      "forge-secret",
      "replacement",
    ]);
    await settings.save({
      enabled: false,
      url: configured.url,
      clearToken: true,
    });
    await expect(settings.view()).resolves.toStrictEqual({
      enabled: false,
      url: configured.url,
      hasToken: false,
    });
    expect((await forgejo.read()).token).toBe("forge-secret");
  });

  it("never reuses a credential on a different URL and never falls back to plaintext", async () => {
    await settings.save(configured);
    await expect(
      settings.save({ enabled: true, url: "https://other.example.com" })
    ).rejects.toThrow("URL and token");
    expect((await settings.read()).url).toBe(configured.url);
    vi.spyOn(secrets, "set").mockRejectedValue(new CredentialStoreError());
    await expect(
      settings.save({ ...configured, token: "replacement" })
    ).rejects.toThrow("OS credential store");
    expect((await settings.read()).token).toBe(configured.token);
    expect(
      fs.readFileSync(path.join(dir, "integrations/jira.json"), "utf-8")
    ).not.toContain("replacement");
  });

  it("enforces HTTPS and rejects embedded credentials or query strings", () => {
    for (const url of [
      "http://jira.example.com",
      "https://alice:secret@example.com",
      "https://example.com?token=secret",
      "https://example.com#secret",
      "file:///tmp/jira",
      "https://example.com/%2fother",
    ]) {
      expect(() => jiraUrl(url)).toThrow();
    }
    expect(jiraUrl(" http://127.0.0.1:8080/jira/ ")).toBe(
      "http://127.0.0.1:8080/jira"
    );
  });

  it("does not access the credential store or network when disabled, and reports missing credentials", async () => {
    const fetcher = vi.fn();
    const jira = new Jira(settings, fetcher);
    await expect(jira.tickets()).rejects.toMatchObject({ status: 412 });
    await settings.save(configured);
    await settings.save({ enabled: false, url: configured.url });
    const get = vi.spyOn(secrets, "get");
    await expect(jira.ticket("APP-1")).rejects.toMatchObject({ status: 412 });
    expect(get).not.toHaveBeenCalled();
    await settings.save({ enabled: true, url: configured.url });
    secrets.values.clear();
    await expect(jira.tickets()).rejects.toThrow(
      "missing from the OS credential store"
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Jira Server/Data Center API", () => {
  it("defaults to assigned tickets and pages using the server's returned count", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(page([issue()], 2)))
      .mockResolvedValueOnce(response(page([issue("APP-2")], 2, 1)));
    const jira = new Jira(settings, fetcher);
    const first = await jira.tickets();
    expect(first).toMatchObject({
      total: 2,
      nextStartAt: 1,
      tickets: [
        {
          key: "APP-1",
          title: "Fix login",
          url: `${configured.url}/browse/APP-1`,
        },
      ],
    });
    await expect(
      jira.tickets("", first.nextStartAt)
    ).resolves.not.toHaveProperty("nextStartAt");
    for (const [url, init] of fetcher.mock.calls) {
      const parsed = new URL(String(url));
      expect(parsed.pathname).toBe("/jira/rest/api/2/search");
      expect(parsed.searchParams.get("jql")).toBe(
        "assignee = currentUser() ORDER BY updated DESC"
      );
      expect(parsed.searchParams.get("maxResults")).toBe("50");
      expect(init?.headers).toMatchObject({
        authorization: "Bearer jira-secret",
      });
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(
      new URL(String(fetcher.mock.calls[1][0])).searchParams.get("startAt")
    ).toBe("1");
    expect(JSON.stringify(first)).not.toContain("jira-secret");
  });

  it("searches exact keys across assignees and safely quotes text as a Lucene phrase", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response(page([])));
    const jira = new Jira(settings, fetcher);
    await jira.tickets(" app-123 ");
    expect(
      new URL(String(fetcher.mock.calls[0][0])).searchParams.get("jql")
    ).toBe('key = "APP-123"');
    const text = 'login" OR assignee = admin';
    await jira.tickets(text);
    const jql = new URL(String(fetcher.mock.calls[1][0])).searchParams.get(
      "jql"
    )!;
    expect(jql).toBe(
      `text ~ ${JSON.stringify('"login\\" OR assignee = admin"')} ORDER BY updated DESC`
    );
    expect(jql).not.toContain("currentUser()");
  });

  it("loads ticket details and builds links from the configured instance", async () => {
    await settings.save(configured);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(issue()))
      .mockResolvedValueOnce(
        response(
          issue("APP-1", {
            description: null,
            assignee: null,
            priority: null,
            reporter: null,
          })
        )
      );
    const jira = new Jira(settings, fetcher);
    await expect(jira.ticket("app-1")).resolves.toMatchObject({
      key: "APP-1",
      project: "App",
      instanceUrl: configured.url,
      description: "Fails on Safari\\\nAcceptance: login succeeds",
      labels: ["login"],
      assignee: "Alice",
      reporter: "Bob",
      priority: "High",
      url: `${configured.url}/browse/APP-1`,
    });
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "/rest/api/2/issue/APP-1?fields="
    );
    await expect(jira.ticket("APP-1")).resolves.toMatchObject({
      description: "",
    });
  });

  it("rejects invalid keys, searches and offsets before sending any credentials", async () => {
    await settings.save(configured);
    const fetcher = vi.fn();
    const jira = new Jira(settings, fetcher);
    for (const key of ["..", "APP-1?x=y", "APP/1", "APP-0"]) {
      await expect(jira.ticket(key)).rejects.toMatchObject({ status: 400 });
    }
    for (const offset of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(jira.tickets("", offset)).rejects.toMatchObject({
        status: 400,
      });
    }
    await expect(jira.tickets("x".repeat(501))).rejects.toMatchObject({
      status: 400,
    });
    await expect(jira.tickets("x\ny")).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sanitizes authentication, upstream, network and redirect errors", async () => {
    await settings.save(configured);
    for (const status of [401, 403, 404, 429, 500]) {
      const jira = new Jira(
        settings,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            new Response("jira-secret upstream details", { status })
          )
      );
      const err = await jira.tickets().catch((error: Error) => error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain("jira-secret");
      expect((err as Error).message).not.toContain("upstream details");
      expect(err).toMatchObject({ status: status === 404 ? 404 : 502 });
    }
    await expect(
      new Jira(
        settings,
        vi.fn().mockRejectedValue(new Error("jira-secret redirect"))
      ).tickets()
    ).rejects.toThrow("Could not reach Jira");
  });

  it("bounds responses and rejects malformed lists and details", async () => {
    await settings.save(configured);
    for (const value of [
      null,
      {},
      page([issue()], -1),
      page([], 1),
      page([issue()], 1, 5),
      page([issue("../APP-1")]),
    ]) {
      await expect(
        new Jira(
          settings,
          vi.fn<typeof fetch>().mockResolvedValue(response(value))
        ).tickets()
      ).rejects.toMatchObject({ status: 502 });
    }
    await expect(
      new Jira(
        settings,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("<html>secret</html>"))
      ).tickets()
    ).rejects.toThrow("invalid API response");
    await expect(
      new Jira(
        settings,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            response(issue("APP-1", { description: { content: [] } }))
          )
      ).ticket("APP-1")
    ).rejects.toThrow("invalid ticket details");
    await expect(
      new Jira(
        settings,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(new Uint8Array(20 * 1024 * 1024 + 1)))
      ).tickets()
    ).rejects.toThrow("20 MiB");
  });
});
