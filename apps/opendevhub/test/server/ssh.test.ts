import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { spawnRunner } from "../../src/server/exec";
import {
  SshHost,
  type Spawn,
  clientArgs,
  describeSshFailure,
  masterArgs,
  parseSshPort,
  remoteCommand,
  shellQuote,
} from "../../src/server/ssh";
import { fakeRunner } from "../helpers/fake-runner";

const target = { dest: "tim@box", control: "/tmp/odh/box.sock" };

describe("shellQuote", () => {
  it.each([
    ["plain", "plain"],
    ["/a/b-c_d.json", "/a/b-c_d.json"],
    ["label=opendevhub.env", "label=opendevhub.env"],
    ["a b", "'a b'"],
    ["it's", `'it'\\''s'`],
    ["$HOME", "'$HOME'"],
    ["", "''"],
  ])("%j → %s", (input, quoted) => {
    expect(shellQuote(input)).toBe(quoted);
  });

  it("survives a real shell unchanged", async () => {
    const args = ["a b", "it's", "$HOME", "", "back\\slash", "semi;colon", "{{json .}}"];
    const r = await spawnRunner("sh", ["-c", remoteCommand("printf", ["%s|", ...args])]);
    expect(r.stdout).toBe(args.map((a) => `${a}|`).join(""));
  });
});

describe("remoteCommand", () => {
  it("prefixes env assignments with env", () => {
    expect(remoteCommand("docker", ["ps"], { A: "1", B: "x y" })).toBe("env A=1 'B=x y' docker ps");
  });
});

describe("ssh arguments", () => {
  it("never prompts and reuses the master", () => {
    expect(clientArgs(target)).toEqual(["-S", "/tmp/odh/box.sock", "-o", "BatchMode=yes"]);
  });

  it("runs the master in the foreground with keepalives", () => {
    expect(masterArgs(target)).toEqual([
      "-M", "-N", "-S", "/tmp/odh/box.sock",
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
      "tim@box",
    ]);
    expect(masterArgs(target)).not.toContain("-f");
  });

  it("reads the port from ssh -G", () => {
    expect(parseSshPort("user tim\nhostname box.lan\nport 2222\n")).toBe(2222);
    expect(parseSshPort("user tim\n")).toBe(22);
  });
});

describe("describeSshFailure", () => {
  it("asks for a host key and ssh key on auth problems", () => {
    expect(describeSshFailure("tim@box", "Host key verification failed.\n")).toBe(
      "add the host key and an ssh key for tim@box first (run `ssh tim@box` once)",
    );
    expect(describeSshFailure("tim@box", "tim@box: Permission denied (publickey).\n")).toContain("add the host key");
  });

  it("quotes ssh's last line otherwise", () => {
    expect(describeSshFailure("tim@box", "debug\nssh: connect to host box port 22: No route to host\n")).toBe(
      "ssh to tim@box failed: ssh: connect to host box port 22: No route to host",
    );
    expect(describeSshFailure("tim@box", "")).toBe("ssh to tim@box exited");
  });
});

describe("SshHost.run", () => {
  it("runs the quoted command over the master, keeping local options", async () => {
    const fake = fakeRunner();
    const host = new SshHost("box", target, fake.run);
    const onLine = () => {};
    await host.run("docker", ["ps", "--filter", "label=a b"], { env: { X: "1" }, timeoutMs: 5, onLine });
    expect(fake.calls).toEqual([
      {
        cmd: "ssh",
        args: ["-S", "/tmp/odh/box.sock", "-o", "BatchMode=yes", "tim@box", "env X=1 docker ps --filter 'label=a b'"],
        opts: { timeoutMs: 5, onLine },
      },
    ]);
  });
});

describe("SshHost files", () => {
  it("reads with cat and reports failures with ssh's stderr", async () => {
    const ok = fakeRunner(() => ({ stdout: "{}\n" }));
    expect(await new SshHost("box", target, ok.run).readFile("/x/a b.json")).toBe("{}\n");
    expect(ok.calls[0].args.at(-1)).toBe("cat '/x/a b.json'");

    const missing = fakeRunner(() => ({ exitCode: 1, stderr: "cat: /x: No such file or directory\n" }));
    await expect(new SshHost("box", target, missing.run).readFile("/x")).rejects.toThrow(/reading \/x on box failed: .*No such file/);
  });

  it("writes through stdin, creating the folder", async () => {
    const fake = fakeRunner();
    await new SshHost("box", target, fake.run).writeFile("/x/y.json", "content");
    expect(fake.calls[0].args.at(-1)).toBe(`sh -c 'mkdir -p "$(dirname "$1")" && cat > "$1"' sh /x/y.json`);
    expect(fake.calls[0].opts?.input).toBe("content");
  });
});

describe("SshHost.dial", () => {
  /** Stands in for `ssh -W`: runs a node script with the same stdio, recording the arguments. */
  function scripted(script: string) {
    const calls: string[][] = [];
    const fake: Spawn = (cmd, args) => {
      calls.push([cmd, ...args]);
      return spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
    };
    return { fake, calls };
  }

  it("opens a channel with -W through the master", async () => {
    const { fake, calls } = scripted("process.stdin.pipe(process.stdout)");
    const stream = await new SshHost("box", target, fakeRunner().run, fake).dial("172.17.0.5", 4096);
    expect(calls[0]).toEqual(["ssh", "-S", "/tmp/odh/box.sock", "-o", "BatchMode=yes", "-W", "172.17.0.5:4096", "tim@box"]);
    stream.write("ping");
    const [data] = (await once(stream, "data")) as [Buffer];
    expect(data.toString()).toBe("ping");
    stream.destroy();
  });

  it("fails the stream with ssh's message when the channel can't open", async () => {
    const { fake } = scripted(
      "process.stderr.write('channel 0: open failed: connect failed: Connection refused\\nstdio forwarding failed\\n'); process.exit(255)",
    );
    const stream = await new SshHost("box", target, fakeRunner().run, fake).dial("172.17.0.5", 9);
    const [err] = (await once(stream, "error")) as [Error];
    expect(err.message).toContain("Connection refused");
  });
});
