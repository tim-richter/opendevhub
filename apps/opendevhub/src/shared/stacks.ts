/** Base images for repos opendevhub writes a devcontainer for, in detection order. */
export type StackId =
  | "node"
  | "python"
  | "go"
  | "rust"
  | "ruby"
  | "java"
  | "dotnet"
  | "php"
  | "generic";

export interface Stack {
  id: StackId;
  label: string;
  image: string;
}

const MCR = "mcr.microsoft.com/devcontainers";

export const STACKS: Record<StackId, Stack> = {
  dotnet: { id: "dotnet", image: `${MCR}/dotnet:8.0`, label: ".NET" },
  generic: {
    id: "generic",
    image: `${MCR}/base:ubuntu`,
    label: "Other (Ubuntu)",
  },
  go: { id: "go", image: `${MCR}/go:1`, label: "Go" },
  java: { id: "java", image: `${MCR}/java:21`, label: "Java" },
  node: { id: "node", image: `${MCR}/javascript-node:22`, label: "Node.js" },
  php: { id: "php", image: `${MCR}/php:8`, label: "PHP" },
  python: { id: "python", image: `${MCR}/python:3`, label: "Python" },
  ruby: { id: "ruby", image: `${MCR}/ruby:3`, label: "Ruby" },
  rust: { id: "rust", image: `${MCR}/rust:1`, label: "Rust" },
};

export const STACK_IDS = Object.keys(STACKS) as StackId[];

/** Installs opencode v2 on every image above; opendevhub finds the binary in ~/.opencode/bin. */
export const OPENCODE_INSTALL =
  "curl -fsSL https://opencode.ai/v2/install | bash";

export const isStackId = (value: unknown): value is StackId =>
  typeof value === "string" && Object.hasOwn(STACKS, value);

/** The devcontainer.json opendevhub writes; the dialog previews the same text. */
export const renderDevcontainer = (name: string, stack: StackId): string =>
  `${JSON.stringify({ name, image: STACKS[stack].image, postCreateCommand: OPENCODE_INSTALL }, null, 2)}\n`;
