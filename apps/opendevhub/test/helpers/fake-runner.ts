import type {
  RunOptions,
  RunResult,
  Runner,
} from "../../src/server/nodes/exec";

export interface Call {
  cmd: string;
  args: string[];
  opts?: RunOptions;
}

export function fakeRunner(
  handler: (
    call: Call
  ) => Partial<RunResult> | Promise<Partial<RunResult>> = () => ({})
) {
  const calls: Call[] = [];
  const run: Runner = async (cmd, args, opts) => {
    const call = { cmd, args, opts };
    calls.push(call);
    const r = await handler(call);
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, ...r };
  };
  return { run, calls };
}
