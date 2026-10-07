import { beforeEach, describe, expect, it, vi } from "vitest";

import { CredentialStoreError, OsSecretStore } from "../../src/server/secrets";

const calls = vi.hoisted(() => ({
  entry: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor(service: string, account: string, options: unknown) {
      calls.entry(service, account, options);
    }
    getPassword = calls.get;
    setPassword = calls.set;
    deleteCredential = calls.remove;
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  calls.get.mockResolvedValue("test-secret");
  calls.set.mockResolvedValue(undefined);
  calls.remove.mockResolvedValue(true);
});

describe("OS credential store", () => {
  it("uses a separate service for Jira credentials", async () => {
    const store = new OsSecretStore("opendevhub.jira");
    await store.set("jira-id", "jira-secret");
    expect(calls.entry).toHaveBeenCalledWith("opendevhub.jira", "jira-id", {
      linux: { store: "secret-service" },
    });
  });

  it("requires persistent Secret Service on Linux and performs native credential operations", async () => {
    const store = new OsSecretStore();
    await store.set("entry-id", "test-secret");
    await expect(store.get("entry-id")).resolves.toBe("test-secret");
    await store.remove("entry-id");
    expect(calls.entry).toHaveBeenCalledWith("opendevhub.forgejo", "entry-id", {
      linux: { store: "secret-service" },
    });
    expect(calls.set).toHaveBeenCalledWith("test-secret");
    expect(calls.get).toHaveBeenCalled();
    expect(calls.remove).toHaveBeenCalled();
  });

  it("distinguishes a missing entry from a locked or unavailable store without echoing secrets", async () => {
    const store = new OsSecretStore();
    calls.get.mockResolvedValue(undefined);
    await expect(store.get("missing")).resolves.toBeUndefined();
    for (const [mock, operation] of [
      [calls.get, () => store.get("entry")],
      [calls.set, () => store.set("entry", "test-secret")],
      [calls.remove, () => store.remove("entry")],
    ] as const) {
      mock.mockRejectedValue(new Error("native error containing test-secret"));
      const error = await operation().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(CredentialStoreError);
      expect((error as Error).message).not.toContain("test-secret");
    }
  });
});
