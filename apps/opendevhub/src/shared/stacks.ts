/** Base images for repos opendevhub writes a devcontainer for, in detection order. */
export type StackId = "node" | "python" | "go" | "rust" | "ruby" | "java" | "dotnet" | "php" | "generic";

export interface Stack {
  id: StackId;
  label: string;
  image: string;
}

const MCR = "mcr.microsoft.com/devcontainers";

export const STACKS: Record<StackId, Stack> = {
  node: { id: "node", label: "Node.js", image: `${MCR}/javascript-node:22` },
  python: { id: "python", label: "Python", image: `${MCR}/python:3` },
  go: { id: "go", label: "Go", image: `${MCR}/go:1` },
  rust: { id: "rust", label: "Rust", image: `${MCR}/rust:1` },
  ruby: { id: "ruby", label: "Ruby", image: `${MCR}/ruby:3` },
  java: { id: "java", label: "Java", image: `${MCR}/java:21` },
  dotnet: { id: "dotnet", label: ".NET", image: `${MCR}/dotnet:8.0` },
  php: { id: "php", label: "PHP", image: `${MCR}/php:8` },
  generic: { id: "generic", label: "Other (Ubuntu)", image: `${MCR}/base:ubuntu` },
};

export const STACK_IDS = Object.keys(STACKS) as StackId[];

/** Installs opencode v2 on every image above; opendevhub finds the binary in ~/.opencode/bin. */
export const OPENCODE_INSTALL = "curl -fsSL https://opencode.ai/v2/install | bash";

export function isStackId(value: unknown): value is StackId {
  return typeof value === "string" && Object.hasOwn(STACKS, value);
}

/** The devcontainer.json opendevhub writes; the dialog previews the same text. */
export function renderDevcontainer(name: string, stack: StackId): string {
  return `${JSON.stringify({ name, image: STACKS[stack].image, postCreateCommand: OPENCODE_INSTALL }, null, 2)}\n`;
}
