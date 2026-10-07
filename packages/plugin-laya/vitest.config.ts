import { defineConfig } from "vitest/config";

/**
 * Several tests in this package spawn a real child process (the fake server) and poll it, so the
 * default 5 s test timeout is too tight under a loaded machine or a parallel `pnpm -r test` run.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
