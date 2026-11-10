import { defineConfig } from "vitest/config";

/** LanceDB opens native tables and the frame tests boot jsdom; both are slower than pure units. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
