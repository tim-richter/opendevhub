/** This machine's git and ssh setup, as the Git settings show it. */

export interface GitIdentityView {
  name?: string;
  email?: string;
}

/** One ssh key, as `ssh-add -l` or `ssh-keygen -l` lists it. */
export interface SshKeyView {
  bits: number;
  type: string;
  fingerprint: string;
  comment: string;
  /** The key file, for keys found in ~/.ssh. */
  path?: string;
}

/** A key file ssh would offer a host, from `ssh -G`. */
export interface SshIdentityFile {
  path: string;
  exists: boolean;
  /** Its fingerprint is loaded in the ssh agent, which is what task containers use. */
  inAgent: boolean;
}

/** An ssh git host that a project's remotes point at. */
export interface SshHostView {
  /** `host`, or `[host]:port` off port 22, as known_hosts names it. */
  host: string;
  /** The ssh user of the remote URL, such as `git`. */
  user: string;
  /** Names of the projects with a remote on this host. */
  projects: string[];
  /** This machine's known_hosts has the host's key, so connecting doesn't prompt. */
  known: boolean;
  identityFiles: SshIdentityFile[];
}

/** A project whose git identity differs from the global one, through its repo config or an includeIf. */
export interface ProjectIdentityView {
  projectId: string;
  project: string;
  identity: GitIdentityView;
}

export interface GitSetup {
  /** `git --version`; absent when git isn't installed. */
  version?: string;
  identity: GitIdentityView;
  signing: { enabled: boolean; format?: string; key?: string };
  agent: {
    /** SSH_AUTH_SOCK is set and the agent answers. */
    running: boolean;
    keys: SshKeyView[];
    error?: string;
  };
  /** Public keys in ~/.ssh. */
  keyFiles: SshKeyView[];
  hosts: SshHostView[];
  projects: ProjectIdentityView[];
}

export interface SshTestResult {
  ok: boolean;
  /** What the server said, such as "Hi tim! You've successfully authenticated…", or why it failed. */
  message: string;
}
