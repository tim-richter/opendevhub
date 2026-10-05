import { type SpawnOptions, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EditorInfo } from "../shared/types";

/** What an editor gets to open: the container path always, the host path when the checkout is mounted. */
export interface OpenTarget {
  containerPath: string;
  hostPath?: string;
  containerName?: string;
}

export interface LaunchSpec {
  cmd: string;
  args: string[];
  cwd?: string;
}

interface EditorDef extends EditorInfo {
  build: (t: OpenTarget) => LaunchSpec | undefined;
}

export type Which = (names: string[]) => Promise<string | undefined>;

const JETBRAINS: [string[], string][] = [
  [["idea", "intellij-idea-ultimate", "intellij-idea-community", "idea-ultimate", "idea-community"], "IntelliJ IDEA"],
  [["webstorm"], "WebStorm"],
  [["pycharm", "pycharm-professional", "pycharm-community"], "PyCharm"],
  [["goland"], "GoLand"],
  [["rustrover"], "RustRover"],
  [["clion"], "CLion"],
  [["phpstorm"], "PhpStorm"],
  [["rubymine"], "RubyMine"],
  [["rider"], "Rider"],
];

/** How to start `cmd` in `dir` for each terminal; unknown terminals get the common `-e` and the spawn cwd. */
const TERMINALS: Record<string, (dir: string, cmd: string[]) => string[]> = {
  kitty: (d, c) => ["--directory", d, ...c],
  ghostty: (d, c) => [`--working-directory=${d}`, "-e", ...c],
  wezterm: (d, c) => ["start", "--cwd", d, "--", ...c],
  alacritty: (d, c) => ["--working-directory", d, "-e", ...c],
  foot: (d, c) => [`--working-directory=${d}`, ...c],
  "gnome-terminal": (d, c) => [`--working-directory=${d}`, "--", ...c],
  konsole: (d, c) => ["--workdir", d, "-e", ...c],
  "xfce4-terminal": (d, c) => [`--working-directory=${d}`, "-x", ...c],
  "x-terminal-emulator": (_d, c) => ["-e", ...c],
};

function hex(text: string): string {
  return Buffer.from(text, "utf8").toString("hex");
}

/** VS Code's Dev Containers URI for attaching to an already running container. */
export function attachedContainerUri(containerName: string, folder: string): string {
  return `vscode-remote://attached-container+${hex(JSON.stringify({ containerName: `/${containerName}` }))}${encodeURI(folder)}`;
}

const host =
  (cmd: string, extra: string[] = []) =>
  (t: OpenTarget): LaunchSpec | undefined =>
    t.hostPath ? { cmd, args: [...extra, t.hostPath], cwd: t.hostPath } : undefined;

export async function detectEditors(which: Which, env: NodeJS.ProcessEnv = process.env): Promise<EditorDef[]> {
  const out: EditorDef[] = [];
  const code = await which(["code"]);
  if (code) {
    out.push({
      id: "vscode-container",
      label: "VS Code (attach to container)",
      target: "container",
      build: (t) =>
        t.containerName
          ? { cmd: code, args: ["--folder-uri", attachedContainerUri(t.containerName, t.containerPath)] }
          : undefined,
    });
    out.push({ id: "vscode", label: "VS Code", target: "host", build: host(code, ["--new-window"]) });
  }
  const cursor = await which(["cursor"]);
  if (cursor) out.push({ id: "cursor", label: "Cursor", target: "host", build: host(cursor, ["--new-window"]) });
  const zed = await which(["zed", "zeditor", "zedit"]);
  if (zed) out.push({ id: "zed", label: "Zed", target: "host", build: host(zed, ["--new"]) });
  for (const [names, label] of JETBRAINS) {
    const bin = await which(names);
    if (bin) out.push({ id: `jetbrains-${names[0]}`, label, target: "host", build: host(bin) });
  }
  const neovide = await which(["neovide"]);
  if (neovide) out.push({ id: "neovide", label: "Neovide", target: "host", build: host(neovide) });
  const nvim = await which(["nvim"]);
  const terminal = nvim && (await findTerminal(which, env));
  if (nvim && terminal) {
    const flags = TERMINALS[path.basename(terminal)] ?? TERMINALS["x-terminal-emulator"];
    out.push({
      id: "nvim-terminal",
      label: `Neovim (${path.basename(terminal)})`,
      target: "host",
      build: (t) =>
        t.hostPath ? { cmd: terminal, args: flags(t.hostPath, [nvim, "."]), cwd: t.hostPath } : undefined,
    });
  }
  return out;
}

async function findTerminal(which: Which, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const preferred = env.TERMINAL?.trim();
  if (preferred) {
    const found = await which([preferred]);
    if (found) return found;
  }
  for (const name of Object.keys(TERMINALS)) {
    const found = await which([name]);
    if (found) return found;
  }
  return undefined;
}

/** Finds executables on PATH plus the places editor installers drop launchers that PATH often misses. */
export function pathWhich(env: NodeJS.ProcessEnv = process.env): Which {
  const home = os.homedir();
  const dirs = [
    ...(env.PATH ?? "").split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".local", "share", "JetBrains", "Toolbox", "scripts"),
    "/snap/bin",
  ];
  return async (names) => {
    for (const name of names) {
      if (path.isAbsolute(name)) {
        if (await isExecutable(name)) return name;
        continue;
      }
      for (const dir of dirs) {
        const candidate = path.join(dir, name);
        if (await isExecutable(candidate)) return candidate;
      }
    }
    return undefined;
  };
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.X_OK);
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

export class EditorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditorUnavailableError";
  }
}

export type Spawner = (cmd: string, args: string[], opts: SpawnOptions) => ReturnType<typeof spawn>;

/** Starts editors on this machine; opendevhub runs where the browser does, so it can launch them directly. */
export class EditorLauncher {
  constructor(
    private readonly editors: EditorDef[],
    private readonly spawner: Spawner = spawn,
    private readonly settleMs = 1500,
  ) {}

  list(): EditorInfo[] {
    return this.editors.map(({ id, label, target }) => ({ id, label, target }));
  }

  /** Resolves once the editor is running (or exited cleanly); rejects if it fails to start. */
  open(editorId: string, target: OpenTarget): Promise<void> {
    const editor = this.editors.find((e) => e.id === editorId);
    if (!editor) throw new EditorUnavailableError(`unknown editor ${editorId}`);
    const spec = editor.build(target);
    if (!spec) {
      throw new EditorUnavailableError(
        editor.target === "host"
          ? `${editor.label} needs the checkout on this machine; this one only exists inside the container`
          : `${editor.label} needs a running container`,
      );
    }
    return new Promise((resolve, reject) => {
      let stderr = "";
      let done = false;
      const settle = (err?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.stderr?.removeAllListeners();
        child.stderr?.destroy();
        child.unref();
        if (err) reject(err);
        else resolve();
      };
      const child = this.spawner(spec.cmd, spec.args, {
        cwd: spec.cwd,
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      child.stderr?.on("data", (c: Buffer) => (stderr = (stderr + c.toString("utf8")).slice(-2000)));
      child.on("error", (err) => settle(new Error(`could not start ${editor.label}: ${err.message}`)));
      child.on("exit", (code) => {
        if (code && code !== 0) {
          const detail = stderr.trim().split("\n").at(-1);
          settle(new Error(`${editor.label} exited with code ${code}${detail ? `: ${detail}` : ""}`));
        } else settle();
      });
      const timer = setTimeout(() => settle(), this.settleMs);
    });
  }
}
