import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import type { ExamItem } from "./generate.js";
import type { CheckFinding } from "./knowledge/report.js";
import { parseMarkup, tokenizeInline } from "./markup.js";

/**
 * Server-side math (spec 10.2). The vendored KaTeX UMD bundle is evaluated once in an isolated
 * `vm` context (no `require`, no process, no I/O) and its `renderToString` is used from Node, so
 * formulas are typeset in the HTML and the page needs no math script and no network.
 */

interface KatexApi {
  renderToString(latex: string, options: Record<string, unknown>): string;
}

const vendorDir = fileURLToPath(new URL("../templates/html/vendor/katex/", import.meta.url));

export const katexVendorPath = (...segments: string[]): string => join(vendorDir, ...segments);

let cached: KatexApi | undefined;

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
  /** Set when KaTeX rejected the formula; the caller fails the build gate (EVL-ITM-011). */
  error?: string;
}

/** Typesets a LaTeX fragment; never throws on bad input, `trust` stays off and expansion is capped. */
export function renderMath(latex: string, display: boolean): MathResult {
  try {
    const html = loadKatex().renderToString(latex, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      strict: "error",
      maxExpand: 1000,
      maxSize: 50,
      output: "html",
    });
    if (html.includes("katex-error")) {
      return { html, error: "KaTeX rejected the formula" };
    }
    return { html };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { html: '<span class="math-error">?</span>', error: message.slice(0, 200) };
  }
}

/** The `MathRenderer` for the HTML emitter. */
export const evaluaMathRenderer = (tex: string, display: boolean): string =>
  renderMath(tex, display).html;

let cachedCss: string | undefined;

/** KaTeX CSS with every shipped `woff2` font inlined as a data URI (no network reference). */
export function katexCss(): string {
  if (cachedCss !== undefined) return cachedCss;
  const css = readFileSync(katexVendorPath("katex.min.css"), "utf8");
  cachedCss = css.replace(
    /src:url\(fonts\/([A-Za-z0-9_-]+)\.woff2\) format\("woff2"\),url\(fonts\/[A-Za-z0-9_-]+\.woff\) format\("woff"\),url\(fonts\/[A-Za-z0-9_-]+\.ttf\) format\("truetype"\)/g,
    (_match, file: string) => {
      const data = readFileSync(katexVendorPath("fonts", `${file}.woff2`)).toString("base64");
      return `src:url(data:font/woff2;base64,${data}) format("woff2")`;
    },
  );
  return cachedCss;
}

interface Fragment {
  tex: string;
  display: boolean;
}

function fragmentsOf(lines: readonly string[]): Fragment[] {
  const fragments: Fragment[] = [];
  for (const block of parseMarkup(lines)) {
    if (block.kind === "display") {
      fragments.push({ tex: block.value, display: true });
      continue;
    }
    const inline = block.kind === "paragraph" ? block.inline : block.head.flat();
    for (const token of inline) {
      if (token.kind === "math") fragments.push({ tex: token.value, display: false });
    }
  }
  return fragments;
}

/** Every formula an item shows must be typeset by KaTeX (EVL-ITM-011). */
export function checkKatexItem(item: ExamItem): CheckFinding[] {
  const fragments: Fragment[] = [
    ...fragmentsOf(item.stem),
    ...item.options.flatMap((option) =>
      tokenizeInline(option.display)
        .filter((token) => token.kind === "math")
        .map((token) => ({ tex: token.value, display: false })),
    ),
    ...fragmentsOf(item.solution),
  ];
  const findings: CheckFinding[] = [];
  for (const fragment of fragments) {
    const result = renderMath(fragment.tex, fragment.display);
    if (result.error !== undefined) {
      findings.push({
        id: "EVL-ITM-011",
        severity: "error",
        subject: item.ref,
        message: `KaTeX rejected "${fragment.tex}": ${result.error}`,
      });
    }
  }
  return findings;
}
