import { readFileSync } from "node:fs";
import vm from "node:vm";
import { packagePath } from "../../package-paths.js";

/**
 * Server-side math for the HTML output. The vendored KaTeX browser bundle is a UMD file, so it is
 * evaluated once in an isolated `vm` context (no `require`, no process access, no I/O) and its
 * `renderToString` is used from Node. This keeps formulas in the HTML already typeset: the page
 * needs no math script, formulas are testable offline, and nothing is added to package.json.
 */

interface KatexApi {
  renderToString(latex: string, options: Record<string, unknown>): string;
}

let cached: KatexApi | undefined;

export const katexVendorPath = (...segments: string[]): string =>
  packagePath("templates", "html", "vendor", "katex", ...segments);

function loadKatex(): KatexApi {
  if (cached) return cached;
  const sandbox = { module: { exports: {} as unknown }, exports: {} as unknown };
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(readFileSync(katexVendorPath("katex.min.js"), "utf8"), {
    filename: "katex.min.js",
  }).runInContext(context);
  const api = sandbox.module.exports as KatexApi;
  if (typeof api?.renderToString !== "function") throw new Error("KaTeX bundle did not load");
  cached = api;
  return api;
}

export interface MathResult {
  html: string;
  /** Set when KaTeX rejected the formula; `html` then holds a visible placeholder. */
  error?: string;
}

/** Typeset a LaTeX fragment. Never throws on bad input; `trust` stays off and expansion is capped. */
export function renderMath(latex: string, display: boolean): MathResult {
  try {
    const html = loadKatex().renderToString(latex, {
      displayMode: display,
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxExpand: 1000,
      maxSize: 50,
      output: "htmlAndMathml",
    });
    return { html };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { html: '<span class="math-error">?</span>', error: message.slice(0, 200) };
  }
}
