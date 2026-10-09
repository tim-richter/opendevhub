import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  // node:sqlite exists only under the node: prefix, which tsup strips by default.
  removeNodeProtocol: false,
  // Only loaded by the dev server (OPENDEVHUB_DEV=1); never part of the published bin.
  external: ["vite"],
  outDir: "dist",
  clean: false,
  banner: { js: "#!/usr/bin/env node" },
});
