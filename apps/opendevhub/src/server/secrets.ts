import type { AsyncEntry } from "@napi-rs/keyring";

export interface SecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, secret: string): Promise<void>;
  remove(account: string): Promise<void>;
}

export class CredentialStoreError extends Error {
  constructor() {
    super("The OS credential store is unavailable or locked. Unlock your keychain; on Linux, run an unlocked Secret Service (such as GNOME Keyring or KWallet) in your desktop session.");
    this.name = "CredentialStoreError";
  }
}

/** Lazy loading keeps the optional integration usable on machines without a credential store. */
export class OsSecretStore implements SecretStore {
  private async entry(account: string): Promise<AsyncEntry> {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    // The package's default Linux fallback is a volatile kernel keyring. Require the persistent
    // desktop store explicitly: credentials must survive reboots, and must never fall back to files.
    return new AsyncEntry("opendevhub.forgejo", account, { linux: { store: "secret-service" } });
  }

  async get(account: string): Promise<string | undefined> {
    try { return await (await this.entry(account)).getPassword(); } catch { throw new CredentialStoreError(); }
  }

  async set(account: string, secret: string): Promise<void> {
    try { await (await this.entry(account)).setPassword(secret); } catch { throw new CredentialStoreError(); }
  }

  async remove(account: string): Promise<void> {
    try { await (await this.entry(account)).deleteCredential(); } catch { throw new CredentialStoreError(); }
  }
}
