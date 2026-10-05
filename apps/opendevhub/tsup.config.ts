import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: false,
  banner: { js: "#!/usr/bin/env node" },
});
