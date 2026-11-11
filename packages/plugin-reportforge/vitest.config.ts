import { defineConfig } from "vitest/config";

/** Frame tests boot jsdom; URL tests run a local HTTP server. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
