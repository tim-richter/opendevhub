import type { SecretStore } from "../../src/server/secrets";

/** Test double only. Production always uses the operating system credential store. */
export class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  async get(account: string) {
    return this.values.get(account);
  }
  async set(account: string, secret: string) {
    this.values.set(account, secret);
  }
  async remove(account: string) {
    this.values.delete(account);
  }
}
