import { describe, expect, it } from "vitest";
import {
  agitPushArgs,
  branchPushArgs,
  compareUrl,
  defaultStrategy,
  isPrUrl,
  oneLine,
  parseRemote,
  pushUrls,
  resolveForge,
  splitTitleBody,
  strategiesFor,
} from "../../src/server/forge";

describe("parseRemote", () => {
  it.each([
    ["git@github.com:acme/app.git", { host: "github.com", path: "acme/app", web: "https://github.com" }],
    ["gh:acme/app", { host: "gh", path: "acme/app", web: "https://gh" }],
    ["ssh://git@git.example.com:2222/team/app.git", { host: "git.example.com", path: "team/app", web: "https://git.example.com" }],
    ["https://gitlab.com/group/sub/app.git", { host: "gitlab.com", path: "group/sub/app", web: "https://gitlab.com" }],
    ["http://localhost:3000/odh/demo", { host: "localhost", path: "odh/demo", web: "http://localhost:3000" }],
    ["https://user:s3cret@codeberg.org/me/app.git/", { host: "codeberg.org", path: "me/app", web: "https://codeberg.org" }],
  ])("parses %s", (url, expected) => {
    expect(parseRemote(url)).toEqual(expected);
  });

  it.each(["/srv/git/app.git", "../origin.git", "file:///srv/git/app.git", "", "git@host:single"])("has no forge for %j", (url) => {
    expect(parseRemote(url)).toBeUndefined();
  });

  it("never keeps credentials", () => {
    expect(JSON.stringify(parseRemote("https://user:s3cret@github.com/acme/app.git"))).not.toContain("s3cret");
  });
});

describe("resolveForge", () => {
  const remote = (url: string) => parseRemote(url);

  it("prefers configured forges, mapping ssh aliases to their web host", () => {
    expect(resolveForge(remote("gh:acme/app"), { gh: { kind: "github", web: "https://github.com" } })).toEqual({
      kind: "github",
      webBase: "https://github.com/acme/app",
    });
    expect(resolveForge(remote("git@git.example.com:t/a.git"), { "git.example.com": { kind: "forgejo" } })).toEqual({
      kind: "forgejo",
      webBase: "https://git.example.com/t/a",
    });
  });

  it("knows the big hosted forges and asks for a probe otherwise", () => {
    expect(resolveForge(remote("git@codeberg.org:me/app.git"), {})).toEqual({ kind: "forgejo", webBase: "https://codeberg.org/me/app" });
    expect(resolveForge(remote("git@bitbucket.org:me/app.git"), {})?.kind).toBe("bitbucket");
    expect(resolveForge(remote("git@git.example.com:t/a.git"), {})).toBeUndefined();
    expect(resolveForge(undefined, {})).toEqual({ kind: "unknown" });
  });
});

describe("compareUrl", () => {
  const o = { base: "main", branch: "feature/login", title: "Add login", body: "Adds a login form." };

  it("builds each forge's new-PR page", () => {
    expect(compareUrl({ kind: "github", webBase: "https://github.com/acme/app" }, o)).toBe(
      "https://github.com/acme/app/compare/main...feature/login?quick_pull=1&title=Add+login&body=Adds+a+login+form.",
    );
    expect(compareUrl({ kind: "forgejo", webBase: "https://codeberg.org/me/app" }, o)).toBe(
      "https://codeberg.org/me/app/compare/main...feature/login",
    );
    expect(compareUrl({ kind: "gitlab", webBase: "https://gitlab.com/g/app" }, o)).toBe(
      "https://gitlab.com/g/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Flogin&merge_request%5Btarget_branch%5D=main&merge_request%5Btitle%5D=Add+login&merge_request%5Bdescription%5D=Adds+a+login+form.",
    );
    expect(compareUrl({ kind: "bitbucket", webBase: "https://bitbucket.org/me/app" }, o)).toBe(
      "https://bitbucket.org/me/app/pull-requests/new?source=feature%2Flogin&dest=main",
    );
    expect(compareUrl({ kind: "unknown" }, o)).toBeUndefined();
  });

  it("keeps GitHub URLs under 8000 characters by shortening the body", () => {
    const url = compareUrl({ kind: "github", webBase: "https://github.com/acme/app" }, { ...o, body: "x".repeat(20_000) })!;
    expect(url.length).toBeLessThanOrEqual(8000);
    expect(decodeURIComponent(url)).toContain("…");
  });
});

describe("push arguments", () => {
  it("builds an AGit push with single-line options", () => {
    expect(agitPushArgs({ remote: "origin", base: "release/1.0", topic: "feature/x", title: "Fix\nit", description: "line one\nline two" })).toEqual([
      "push",
      "origin",
      "HEAD:refs/for/release/1.0",
      "-o",
      "topic=feature/x",
      "-o",
      "title=Fix it",
      "-o",
      "description=line one line two",
    ]);
    expect(oneLine("  a\r\n\n b  ")).toBe("a b");
  });

  it("pushes a branch with its upstream", () => {
    expect(branchPushArgs({ remote: "origin", branch: "feature/x" })).toEqual([
      "push",
      "--set-upstream",
      "origin",
      "refs/heads/feature/x:refs/heads/feature/x",
    ]);
  });
});

describe("push output", () => {
  const output = [
    "Enumerating objects: 5, done.",
    "remote: ",
    "remote: Create a pull request for 'feature/x' on GitHub by visiting:",
    "remote:      https://github.com/acme/app/pull/new/feature/x",
    "remote: Visit the existing pull request: https://codeberg.org/me/app/pulls/7 ",
    "To github.com:acme/app.git",
  ].join("\n");

  it("finds every URL the remote printed, and tells existing PRs apart", () => {
    expect(pushUrls(output)).toEqual(["https://github.com/acme/app/pull/new/feature/x", "https://codeberg.org/me/app/pulls/7"]);
    expect(isPrUrl("https://github.com/acme/app/pull/new/feature/x")).toBe(false);
    expect(isPrUrl("https://github.com/acme/app/pull/12")).toBe(true);
    expect(isPrUrl("https://codeberg.org/me/app/pulls/7")).toBe(true);
    expect(isPrUrl("https://gitlab.com/g/app/-/merge_requests/3")).toBe(true);
    expect(isPrUrl("https://bitbucket.org/me/app/pull-requests/9")).toBe(true);
  });
});

describe("titles and strategies", () => {
  it("splits a generated suggestion into title and description", () => {
    expect(splitTitleBody("Add login\n\nAdds a form.\nAnd tests.")).toEqual({ title: "Add login", description: "Adds a form.\nAnd tests." });
    expect(splitTitleBody("  \n Title only ")).toEqual({ title: "Title only", description: "" });
    expect(splitTitleBody("")).toEqual({ title: "", description: "" });
  });

  it("offers AGit only on Forgejo and Gitea, where it is the default", () => {
    expect(strategiesFor("forgejo")).toEqual(["agit", "branch"]);
    expect(strategiesFor("github")).toEqual(["branch"]);
    expect(defaultStrategy("gitea")).toBe("agit");
    expect(defaultStrategy("unknown")).toBe("branch");
  });
});
