import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    environment: "node",
    // One file at a time: they share Docker and the single opendevhub-gateway container (parallel
    // cold starts race on its name), and the warm-start budget in environments.e2e.ts is wall-clock.
    fileParallelism: false,
    testTimeout: 20 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
