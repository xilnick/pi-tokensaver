import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 15_000,
    // Run sequentially to avoid port/process conflicts with tokensave serve
    singleFork: true,
    include: ["test/**/*.test.ts"],
  },
});
