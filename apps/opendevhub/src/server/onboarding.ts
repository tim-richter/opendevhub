import fs from "node:fs/promises";
import path from "node:path";

import { isStackId, renderDevcontainer } from "../shared/stacks";
import type { Candidate, CandidateList } from "../shared/types";
import { scanCandidates } from "./discovery";
import { NotFoundError } from "./orchestrator";
import { InvalidRequestError } from "./worktrees";

export class DevcontainerExistsError extends Error {
  constructor(dir: string) {
    super(`${dir} already has a devcontainer.json`);
    this.name = "DevcontainerExistsError";
  }
}

export interface OnboardingDeps {
  roots: () => string[];
  /** Defaults to scanning the disk; tests pass their own. */
  scan?: (roots: string[]) => Promise<Candidate[]>;
}

/** Add project: lists repos without a devcontainer and writes one into a repo the user picks. */
export class Onboarding {
  private readonly deps: OnboardingDeps;
  constructor(deps: OnboardingDeps) {
    this.deps = deps;
  }

  private scan(): Promise<Candidate[]> {
    return (this.deps.scan ?? ((roots) => scanCandidates(roots)))(
      this.deps.roots()
    );
  }

  async list(): Promise<CandidateList> {
    return { candidates: await this.scan(), roots: this.deps.roots() };
  }

  /**
   * Writes `.devcontainer/devcontainer.json` into `repoPath`, which must be exactly one of the
   * candidates right now: that keeps writes under a root, in a git repo without a devcontainer.
   */
  async add(repoPath: string, stack: unknown): Promise<Candidate> {
    if (!isStackId(stack)) {
      throw new InvalidRequestError(`unknown stack ${String(stack)}`);
    }
    const result = await this.scan();
    const candidate = result.find((c) => c.path === repoPath);
    if (!candidate) {
      throw new NotFoundError(
        repoPath || "(empty path)",
        "repo without a devcontainer"
      );
    }
    const dir = path.join(candidate.path, ".devcontainer");
    await fs.mkdir(dir, { recursive: true });
    try {
      await fs.writeFile(
        path.join(dir, "devcontainer.json"),
        renderDevcontainer(candidate.name, stack),
        { flag: "wx" }
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DevcontainerExistsError(candidate.path);
      }
      throw error;
    }
    return candidate;
  }
}

export type OnboardingPort = Pick<Onboarding, "list" | "add">;
