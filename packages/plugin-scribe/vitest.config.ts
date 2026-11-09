import { defineConfig } from "vitest/config";

/** The real-engine compile test builds Tectonic's LaTeX format on its first run, which is slow. */
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
