import type { Preflight } from "../shared/types";
import type { Runner } from "./exec";

export const preflight = async (run: Runner): Promise<Preflight> => {
  const errors: string[] = [];
  const docker = await run(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    { timeoutMs: 15_000 }
  );
  if (docker.exitCode === 127) {
    errors.push("docker CLI not found on PATH");
  } else if (docker.exitCode !== 0) {
    errors.push("Docker daemon is not reachable — is Docker running?");
  }
  const devcontainer = await run("devcontainer", ["--version"], {
    timeoutMs: 15_000,
  });
  if (devcontainer.exitCode !== 0) {
    errors.push(
      "devcontainer CLI not found on PATH — install it with `npm i -g @devcontainers/cli`"
    );
  }
  return { errors };
};
