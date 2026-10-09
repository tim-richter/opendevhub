import type { AsyncEntry } from "@napi-rs/keyring";

export interface SecretStore {
  get: (account: string) => Promise<string | undefined>;
  set: (account: string, secret: string) => Promise<void>;
  remove: (account: string) => Promise<void>;
}

export type CredentialStoreFailure =
  | "denied"
  | "no-ui"
  | "native-module"
  | "unavailable";

const MESSAGES: Record<CredentialStoreFailure, string> = {
  denied:
    "Access to the OS credential store was denied. Retry and choose “Always Allow” when your system asks; on macOS, check the opendevhub item in Keychain Access if it keeps failing.",
  "native-module":
    "The OS credential store module could not be loaded. Reinstall opendevhub for this platform and architecture.",
  "no-ui":
    "The OS credential store needs a confirmation prompt it cannot show here. Run opendevhub from your desktop session (not over SSH or as a background service), or unlock the keychain first.",
  unavailable:
    "The OS credential store is unavailable or locked. Unlock your keychain; on Linux, run an unlocked Secret Service (such as GNOME Keyring or KWallet) in your desktop session.",
};

// macOS Security framework messages and status codes surfaced through keyring-rs.
const DENIED =
  /user canceled|passphrase you entered is not correct|authorization was denied|access denied|-128\b|-25293\b/iu;
const NO_UI = /interaction is not allowed|-25308\b/iu;

export const classifyCredentialStoreError = (
  error: unknown
): Exclude<CredentialStoreFailure, "native-module"> => {
  const text = error instanceof Error ? error.message : String(error);
  if (NO_UI.test(text)) {
    return "no-ui";
  }
  if (DENIED.test(text)) {
    return "denied";
  }
  return "unavailable";
};

export class CredentialStoreError extends Error {
  readonly reason: CredentialStoreFailure;
  constructor(
    reason: CredentialStoreFailure = "unavailable",
    options?: ErrorOptions
  ) {
    super(MESSAGES[reason], options);
    this.name = "CredentialStoreError";
    this.reason = reason;
  }
}

const errorText = (error: unknown, secret?: string): string => {
  const text = error instanceof Error ? error.message : String(error);
  return secret ? text.replaceAll(secret, "[redacted]") : text;
};

/** Lazy loading keeps the optional integration usable on machines without a credential store. */
export class OsSecretStore implements SecretStore {
  private readonly service: string;
  private readonly log: (message: string) => void;
  constructor(
    service = "opendevhub.forgejo",
    log: (message: string) => void = (message) => console.warn(message)
  ) {
    this.service = service;
    this.log = log;
  }

  private async entry(account: string): Promise<AsyncEntry> {
    let NativeEntry: typeof AsyncEntry;
    try {
      ({ AsyncEntry: NativeEntry } = await import("@napi-rs/keyring"));
    } catch (error) {
      this.log(
        `credential store: could not load @napi-rs/keyring: ${errorText(error)}`
      );
      throw new CredentialStoreError("native-module", { cause: error });
    }
    // The package's default Linux fallback is a volatile kernel keyring. Require the persistent
    // desktop store explicitly: credentials must survive reboots, and must never fall back to files.
    return new NativeEntry(this.service, account, {
      linux: { store: "secret-service" },
    });
  }

  /** Keeps the native cause for diagnosis without ever echoing a secret into the message or log. */
  private async run<T>(
    operation: string,
    account: string,
    fn: (entry: AsyncEntry) => Promise<T>,
    secret?: string
  ): Promise<T> {
    const entry = await this.entry(account);
    try {
      return await fn(entry);
    } catch (error) {
      const reason = classifyCredentialStoreError(error);
      this.log(
        `credential store: ${operation} ${this.service}/${account} failed (${reason}): ${errorText(error, secret)}`
      );
      throw new CredentialStoreError(reason);
    }
  }

  get(account: string): Promise<string | undefined> {
    return this.run("get", account, async (entry) => {
      const value = await entry.getPassword();
      return value ?? undefined;
    });
  }

  set(account: string, secret: string): Promise<void> {
    return this.run(
      "set",
      account,
      (entry) => entry.setPassword(secret),
      secret
    );
  }

  async remove(account: string): Promise<void> {
    await this.run("remove", account, (entry) => entry.deleteCredential());
  }
}
