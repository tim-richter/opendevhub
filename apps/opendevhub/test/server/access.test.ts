import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ACCESS_TOKEN_FILE,
  Access,
  CODE_TTL_MS,
  loadToken,
  readCookie,
  resetToken,
  setCookie,
} from "../../src/server/access";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "odh-access-"));
});
afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true });
});

describe(loadToken, () => {
  it("keeps the same token across loads", () => {
    const token = loadToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
    expect(loadToken(dir)).toBe(token);
  });

  it("creates the file owner-only", () => {
    loadToken(dir);
    const mode = fs.statSync(path.join(dir, ACCESS_TOKEN_FILE)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("replaces a file that doesn't hold a token", () => {
    fs.writeFileSync(path.join(dir, ACCESS_TOKEN_FILE), "short\n");
    expect(loadToken(dir)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe(Access, () => {
  it("accepts the token and the cookies derived from it", () => {
    const access = new Access(dir);
    expect(access.validToken(loadToken(dir))).toBe(true);
    expect(access.validToken("nope")).toBe(false);
    expect(access.validToken(null)).toBe(false);
    expect(
      access.dashboardAllowed(`a=1; odh=${access.dashboardCookie()}`)
    ).toBe(true);
    expect(access.dashboardAllowed("odh=forged")).toBe(false);
    expect(access.dashboardAllowed(undefined)).toBe(false);
    expect(
      access.envAllowed("demo", `odh_env=${access.envCookie("demo")}`)
    ).toBe(true);
    expect(
      access.envAllowed("other", `odh_env=${access.envCookie("demo")}`)
    ).toBe(false);
    // The dashboard cookie doesn't open an environment.
    expect(
      access.envAllowed("demo", `odh_env=${access.dashboardCookie()}`)
    ).toBe(false);
  });

  it("refuses both cookie kinds after a reset, also on a running instance", () => {
    const access = new Access(dir);
    const header = `odh=${access.dashboardCookie()}; odh_env=${access.envCookie("demo")}`;
    const old = access.token();
    resetToken(dir);
    expect(access.token()).not.toBe(old);
    expect(access.dashboardAllowed(header)).toBe(false);
    expect(access.envAllowed("demo", header)).toBe(false);
    expect(access.validToken(old)).toBe(false);
  });

  it("redeems a code once, for its env, before it expires", () => {
    let now = 1000;
    const access = new Access(dir, () => now);
    const code = access.mintCode("demo");
    expect(access.redeemCode("demo", code)).toBe(true);
    expect(access.redeemCode("demo", code)).toBe(false);

    const other = access.mintCode("demo");
    expect(access.redeemCode("elsewhere", other)).toBe(false);
    expect(access.redeemCode("demo", other)).toBe(false);

    const late = access.mintCode("demo");
    now += CODE_TTL_MS;
    expect(access.redeemCode("demo", late)).toBe(false);
    expect(access.redeemCode("demo", undefined)).toBe(false);
  });
});

describe(readCookie, () => {
  it("finds a cookie by exact name", () => {
    expect(readCookie("odh_env=b; odh=a", "odh")).toBe("a");
    expect(readCookie("odh_env=b", "odh")).toBeUndefined();
  });
});

describe(setCookie, () => {
  it("is HttpOnly, SameSite=Strict, host-only and lasts a year", () => {
    const value = setCookie("odh", "v");
    expect(value).toContain("HttpOnly");
    expect(value).toContain("SameSite=Strict");
    expect(value).toContain("Max-Age=31536000");
    expect(value).not.toMatch(/domain/iu);
  });
});
