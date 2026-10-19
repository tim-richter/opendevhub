import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ACCESS_TOKEN_FILE = "access-token";
/** The dashboard's cookie, on `localhost:<port>`. */
export const DASHBOARD_COOKIE = "odh";
/** An environment host's cookie, on `<env>.localhost:<port>`. */
export const ENV_COOKIE = "odh_env";
export const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
export const CODE_TTL_MS = 60_000;

const TOKEN_BYTES = 32;
const TOKEN = /^[0-9a-f]{64}$/u;

const tokenFile = (dir: string): string => path.join(dir, ACCESS_TOKEN_FILE);

const writeToken = (dir: string): string => {
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  const file = tokenFile(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return token;
};

/** Reads the state folder's token, creating it (owner-only) when missing or unreadable as a token. */
export const loadToken = (dir: string): string => {
  let text: string;
  try {
    text = fs.readFileSync(tokenFile(dir), "utf-8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return writeToken(dir);
  }
  return TOKEN.test(text) ? text : writeToken(dir);
};

/** Replaces the token, so every cookie issued for the old one is refused. */
export const resetToken = (dir: string): string => writeToken(dir);

/** The dashboard URL that grants access when opened. */
export const accessUrl = (port: number, token: string): string =>
  `http://localhost:${port}/?token=${token}`;

const hmac = (token: string, purpose: string): string =>
  createHmac("sha256", token).update(purpose).digest("hex");

const sameText = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Reads one cookie out of a `Cookie` header. */
export const readCookie = (
  header: string | undefined,
  name: string
): string | undefined => {
  for (const part of header?.split(";") ?? []) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
};

/** A host-only `Set-Cookie` value: no Domain, so it never reaches another `*.localhost` host. */
export const setCookie = (
  name: string,
  value: string,
  sameSite: "Strict" | "Lax" = "Strict"
): string =>
  `${name}=${value}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=${sameSite}`;

/**
 * Who may use the dashboard: the token, the cookies derived from it, and the one-time codes that open an
 * environment's host. The token is re-read when its file changes, so `opendevhub token --reset` takes effect
 * on a running server.
 */
export class Access {
  private cached?: { token: string; stamp: string };
  private readonly codes = new Map<
    string,
    { envId: string; expires: number }
  >();

  private readonly dir: string;
  private readonly now: () => number;

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
  }

  token(): string {
    const file = tokenFile(this.dir);
    let stamp = "";
    try {
      const st = fs.statSync(file);
      stamp = `${st.ino}:${st.mtimeMs}:${st.size}`;
    } catch {
      // Missing: loadToken creates it.
    }
    if (!this.cached || !stamp || this.cached.stamp !== stamp) {
      const token = loadToken(this.dir);
      const st = fs.statSync(file);
      this.cached = { stamp: `${st.ino}:${st.mtimeMs}:${st.size}`, token };
    }
    return this.cached.token;
  }

  validToken(candidate: string | null | undefined): boolean {
    return !!candidate && sameText(candidate, this.token());
  }

  dashboardCookie(): string {
    return hmac(this.token(), "dashboard");
  }

  envCookie(envId: string): string {
    return hmac(this.token(), `env:${envId}`);
  }

  /** Whether a request's `Cookie` header grants the dashboard. */
  dashboardAllowed(cookieHeader: string | undefined): boolean {
    const value = readCookie(cookieHeader, DASHBOARD_COOKIE);
    return !!value && sameText(value, this.dashboardCookie());
  }

  /** Whether a request's `Cookie` header grants the environment host `envId`. */
  envAllowed(envId: string, cookieHeader: string | undefined): boolean {
    const value = readCookie(cookieHeader, ENV_COOKIE);
    return !!value && sameText(value, this.envCookie(envId));
  }

  /** A code that `redeemCode` exchanges once, within a minute, for `envId`'s cookie. */
  mintCode(envId: string): string {
    this.prune();
    const code = randomBytes(TOKEN_BYTES).toString("hex");
    this.codes.set(code, { envId, expires: this.now() + CODE_TTL_MS });
    return code;
  }

  /** Consumes a code; true only when it was minted for `envId` and hasn't expired or been used. */
  redeemCode(envId: string, code: string | null | undefined): boolean {
    if (!code) {
      return false;
    }
    const entry = this.codes.get(code);
    this.codes.delete(code);
    return !!entry && entry.envId === envId && entry.expires > this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [code, entry] of this.codes) {
      if (entry.expires <= now) {
        this.codes.delete(code);
      }
    }
  }
}
