import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { IntegrationSettings } from "../shared/integrations";
import { OsSecretStore } from "./secrets";
import type { SecretStore } from "./secrets";

export class IntegrationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 412 | 502 = 400
  ) {
    super(message);
    this.name = "IntegrationError";
  }
}

/** HTTPS keeps the token confidential in transit; loopback HTTP is useful for local instances. */
export const integrationUrl = (
  raw: string,
  name: string,
  ErrorType: typeof IntegrationError = IntegrationError
): string => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ErrorType(`Enter a valid ${name} URL.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new ErrorType(
      `Use HTTPS for ${name} (HTTP is allowed only on loopback).`
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /%(?:2f|5c|2e)/iu.test(url.pathname)
  ) {
    throw new ErrorType(
      `The ${name} URL must not contain credentials, a query, or a fragment.`
    );
  }
  return url.href.replace(/\/+$/u, "");
};

interface SavedSettings {
  enabled: boolean;
  url: string;
  tokenRef?: string;
  /** Read only for migrating the previous plaintext format. Never written. */
  token?: string;
}

class InvalidSavedSettingsError extends IntegrationError {
  constructor(message: string, status?: 400 | 404 | 412 | 502) {
    super(message, status);
    this.name = "InvalidSavedSettingsError";
  }
}

/** The file holds only connection settings and an opaque reference into the OS credential store. */
export class FileIntegrationSettings {
  private readonly dir: string;
  private readonly file: string;
  private pending: Promise<void> = Promise.resolve();

  constructor(
    configDir: string,
    private readonly name: string,
    private readonly validateUrl: (raw: string) => string,
    private readonly ErrorType: typeof IntegrationError = IntegrationError,
    private readonly secrets: SecretStore = new OsSecretStore()
  ) {
    this.dir = path.join(configDir, "integrations");
    this.file = path.join(this.dir, `${name.toLowerCase()}.json`);
  }

  /** Serialize migrations and edits so concurrent browser requests cannot lose a token. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.pending.then(fn);
    this.pending = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private record(): SavedSettings {
    let raw: string;
    try {
      fs.chmodSync(this.dir, 0o700);
      fs.chmodSync(this.file, 0o600);
      raw = fs.readFileSync(this.file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { enabled: false, url: "" };
      }
      throw new this.ErrorType(
        `Could not read the saved ${this.name} settings.`,
        502
      );
    }
    try {
      const value = JSON.parse(raw) as SavedSettings;
      if (
        !value ||
        typeof value.enabled !== "boolean" ||
        typeof value.url !== "string" ||
        (value.token !== undefined &&
          (typeof value.token !== "string" ||
            !value.token ||
            /\s/u.test(value.token))) ||
        (value.tokenRef !== undefined &&
          (typeof value.tokenRef !== "string" ||
            !/^[0-9a-f-]{36}$/u.test(value.tokenRef))) ||
        (value.token && value.tokenRef)
      ) {
        throw new Error("invalid settings file");
      }
      return {
        enabled: value.enabled,
        url: value.url ? this.validateUrl(value.url) : "",
        ...(value.token ? { token: value.token } : {}),
        ...(value.tokenRef ? { tokenRef: value.tokenRef } : {}),
      };
    } catch {
      throw new InvalidSavedSettingsError(
        `Saved ${this.name} settings are invalid. Replace them in Settings.`,
        502
      );
    }
  }

  private write(value: SavedSettings): void {
    const tmp = path.join(this.dir, `${randomUUID()}.tmp`);
    try {
      fs.mkdirSync(this.dir, { mode: 0o700, recursive: true });
      fs.chmodSync(this.dir, 0o700);
      // Pick fields explicitly so even migration failures can never write plaintext credentials.
      const saved = {
        enabled: value.enabled,
        url: value.url,
        ...(value.tokenRef ? { tokenRef: value.tokenRef } : {}),
      };
      fs.writeFileSync(tmp, `${JSON.stringify(saved)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      fs.renameSync(tmp, this.file);
    } catch {
      throw new this.ErrorType(`Could not save ${this.name} settings.`, 502);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  private async migrate(value: SavedSettings): Promise<SavedSettings> {
    if (!value.token) {
      return value;
    }
    const tokenRef = randomUUID();
    await this.secrets.set(tokenRef, value.token);
    const migrated = { enabled: value.enabled, tokenRef, url: value.url };
    try {
      this.write(migrated);
    } catch (error) {
      await this.secrets.remove(tokenRef).catch(() => undefined);
      throw error;
    }
    return migrated;
  }

  read(): Promise<{ enabled: boolean; url: string; token?: string }> {
    return this.locked(async () => {
      const value = await this.migrate(this.record());
      const token = value.tokenRef
        ? await this.secrets.get(value.tokenRef)
        : undefined;
      return {
        enabled: value.enabled,
        url: value.url,
        ...(token ? { token } : {}),
      };
    });
  }

  view(): Promise<IntegrationSettings> {
    return this.locked(async () => {
      const value = await this.migrate(this.record());
      return {
        enabled: value.enabled,
        hasToken: !!value.tokenRef,
        url: value.url,
      };
    });
  }

  save(input: Record<string, unknown>): Promise<IntegrationSettings> {
    return this.locked(async () => {
      if (
        typeof input.enabled !== "boolean" ||
        typeof input.url !== "string" ||
        (input.token !== undefined && typeof input.token !== "string") ||
        (input.clearToken !== undefined &&
          typeof input.clearToken !== "boolean")
      ) {
        throw new this.ErrorType(`Invalid ${this.name} settings.`);
      }
      const url = input.url.trim() ? this.validateUrl(input.url) : "";
      const supplied =
        typeof input.token === "string" ? input.token.trim() : undefined;
      if (supplied && (/\s/u.test(supplied) || supplied.length > 4096)) {
        throw new this.ErrorType(`Invalid ${this.name} token.`);
      }
      if (input.clearToken && supplied) {
        throw new this.ErrorType(
          "Choose a new token or remove the saved token."
        );
      }
      let old: SavedSettings;
      try {
        old = this.record();
      } catch (error) {
        if (!(error instanceof InvalidSavedSettingsError)) {
          throw error;
        }
        old = { enabled: false, url: "" };
      }
      const keep = !input.clearToken && !supplied && old.url === url;
      if (
        input.enabled &&
        (!url || (!supplied && !(keep && (old.tokenRef || old.token))))
      ) {
        throw new this.ErrorType(
          `A ${this.name} URL and token are required to enable ${this.name}.`
        );
      }
      if (keep) {
        const kept = await this.migrate(old);
        this.write({ enabled: input.enabled, tokenRef: kept.tokenRef, url });
        return { enabled: input.enabled, hasToken: !!kept.tokenRef, url };
      }
      const tokenRef = supplied ? randomUUID() : undefined;
      const previousToken = old.tokenRef
        ? await this.secrets.get(old.tokenRef)
        : undefined;
      if (tokenRef && supplied) {
        await this.secrets.set(tokenRef, supplied);
      }
      let removedPrevious = false;
      try {
        // Removing/replacing a token must really delete the old credential; failures are reported.
        if (old.tokenRef) {
          await this.secrets.remove(old.tokenRef);
          removedPrevious = true;
        }
        this.write({ enabled: input.enabled, tokenRef, url });
      } catch (error) {
        if (removedPrevious && old.tokenRef && previousToken) {
          await this.secrets
            .set(old.tokenRef, previousToken)
            .catch(() => undefined);
        }
        if (tokenRef) {
          await this.secrets.remove(tokenRef).catch(() => undefined);
        }
        throw error;
      }
      return { enabled: input.enabled, hasToken: !!tokenRef, url };
    });
  }
}
