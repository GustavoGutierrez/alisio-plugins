import { defineConfig } from "vitest/config";

/**
 * Several tests in this package spawn a real Chrome process and poll it (the PDF fallback and the
 * review/finalize flows), so the default 5 s test timeout is too tight under a loaded machine or a
 * parallel `pnpm -r test` run.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
