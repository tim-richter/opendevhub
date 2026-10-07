import fs from "node:fs/promises";

import type { StackId } from "../shared/stacks";

/** Top-level files that identify a stack; the first stack with a match wins. */
const MARKERS: [StackId, (name: string) => boolean][] = [
  ["node", (n) => n === "package.json"],
  [
    "python",
    (n) =>
      n === "pyproject.toml" || n === "requirements.txt" || n === "setup.py",
  ],
  ["go", (n) => n === "go.mod"],
  ["rust", (n) => n === "Cargo.toml"],
  ["ruby", (n) => n === "Gemfile"],
  [
    "java",
    (n) => n === "pom.xml" || n === "build.gradle" || n === "build.gradle.kts",
  ],
  ["dotnet", (n) => n.endsWith(".csproj") || n.endsWith(".sln")],
  ["php", (n) => n === "composer.json"],
];

export const detectStack = async (dir: string): Promise<StackId> => {
  let files: string[];
  try {
    const result = await fs.readdir(dir, { withFileTypes: true });
    files = result.filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return "generic";
  }
  return MARKERS.find(([, match]) => files.some(match))?.[0] ?? "generic";
};
