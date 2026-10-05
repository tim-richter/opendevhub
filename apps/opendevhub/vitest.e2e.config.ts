import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/e2e/**/*.e2e.ts"],
    environment: "node",
    testTimeout: 20 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});
