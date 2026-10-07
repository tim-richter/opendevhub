/** Safe to return to the browser. The saved token never leaves the server. */
export interface IntegrationSettings {
  enabled: boolean;
  url: string;
  hasToken: boolean;
}

export interface IntegrationSettingsInput {
  enabled: boolean;
  url: string;
  /** Omit to keep the saved token. */
  token?: string;
  clearToken?: boolean;
}
