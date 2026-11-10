// The static thumbnail's raw material (decision A): one page's HTML, its stylesheets and SVG
// images. It is sanitized and CSS-scoped in the frame (web/thumbnail.js) and never executed.
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve } from "node:path";
import type { Stack } from "./presets.js";
import type { Files } from "./safety.js";

export interface Snapshot {
  revision: string;
  at: number;
  /** `static`: HTML worth showing; `script`: drawn by JavaScript; `none`: no page yet. */
  kind: "static" | "script" | "none";
  html: string;
  css: string[];
  assets: Record<string, string>;
}

const MAX_HTML = 1_000_000;
const MAX_CSS = 2_000_000;
const MAX_ASSETS = 1_000_000;

const stylesheetHrefs = (html: string) =>
  [...html.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => /\brel\s*=\s*["']?stylesheet/i.test(tag))
    .map((tag) => /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1])
    .filter((href): href is string => !!href && !/^[a-z]+:|^\/\//i.test(href));
const svgRefs = (html: string) =>
  [...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"':]+\.svg)["']/gi)].map((m) => m[1] as string);

/** True when the body has almost no text without its scripts: the page is drawn by JavaScript. */
function scriptRendered(html: string) {
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const textOnly = body
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .trim();
  return textOnly.length < 15 && /<script\b/i.test(html);
}

const svgData = (content: string) =>
  `data:image/svg+xml;base64,${Buffer.from(content, "utf8").toString("base64")}`;

/** Vanilla projects: straight from the revision (plus Tailwind's compiled CSS when given). */
export function sourceSnapshot(files: Files, revision: string, compiledCss?: string): Snapshot {
  const page =
    files["index.html"] !== undefined
      ? "index.html"
      : Object.keys(files).find((f) => f.endsWith(".html"));
  const at = Date.now();
  if (!page) return { revision, at, kind: "none", html: "", css: [], assets: {} };
  const html = (files[page] ?? "").slice(0, MAX_HTML);
  const base = posix.dirname(page);
  const css: string[] = [];
  let size = 0;
  for (const href of stylesheetHrefs(html)) {
    const path = posix.normalize(posix.join(base, href.split(/[?#]/)[0] ?? "")).replace(/^\/+/, "");
    const content =
      files[path] ??
      (compiledCss !== undefined && path === "styles/tailwind.css" ? compiledCss : undefined);
    if (content === undefined || size + content.length > MAX_CSS) continue;
    css.push(content);
    size += content.length;
  }
  const assets: Record<string, string> = {};
  let assetBytes = 0;
  for (const ref of svgRefs(html)) {
    const path = posix.normalize(posix.join(base, ref)).replace(/^\/+/, "");
    const content = files[path];
    if (content === undefined || assetBytes + content.length > MAX_ASSETS) continue;
    assets[ref] = svgData(content);
    assetBytes += content.length;
  }
  return { revision, at, kind: scriptRendered(html) ? "script" : "static", html, css, assets };
}

/** Reads a file inside `root` only (no traversal, no symlink escape), bounded in size. */
async function readInside(root: string, path: string, max: number): Promise<string | undefined> {
  try {
    const realRoot = await realpath(root);
    const real = await realpath(resolve(root, path));
    const rel = relative(realRoot, real);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    if ((await stat(real)).size > max) return undefined;
    return await readFile(real, "utf8");
  } catch {
    return undefined;
  }
}

/** Framework projects: the page a build wrote, with the stylesheets it links. */
export async function buildSnapshot(work: string, s: Stack, revision: string): Promise<Snapshot> {
  const at = Date.now();
  const out = s.output;
  if (!out) return { revision, at, kind: "none", html: "", css: [], assets: {} };
  const outRoot = join(work, out.root);
  let page: string | undefined;
  let html = "";
  for (const candidate of out.html) {
    const content = await readInside(outRoot, candidate, MAX_HTML);
    if (content !== undefined) {
      page = candidate;
      html = content;
      break;
    }
  }
  if (!page) return { revision, at, kind: "none", html: "", css: [], assets: {} };
  /** Maps a URL in the built page to a file under the work folder. */
  const local = (href: string) => {
    const clean = href.split(/[?#]/)[0] ?? "";
    if (out.urlPrefix && out.urlRoot && clean.startsWith(out.urlPrefix))
      return { root: join(work, out.urlRoot), path: clean.slice(out.urlPrefix.length) };
    if (clean.startsWith("/")) return { root: outRoot, path: clean.slice(1) };
    return { root: outRoot, path: posix.join(posix.dirname(page as string), clean) };
  };
  const css: string[] = [];
  let size = 0;
  for (const href of stylesheetHrefs(html)) {
    const { root, path } = local(href);
    const content = await readInside(root, path, MAX_CSS);
    if (content === undefined || size + content.length > MAX_CSS) continue;
    css.push(content);
    size += content.length;
  }
  const assets: Record<string, string> = {};
  let assetBytes = 0;
  for (const ref of svgRefs(html)) {
    const { root, path } = local(ref);
    const content = await readInside(root, path, MAX_ASSETS);
    if (content === undefined || assetBytes + content.length > MAX_ASSETS) continue;
    assets[ref] = svgData(content);
    assetBytes += content.length;
  }
  return { revision, at, kind: scriptRendered(html) ? "script" : "static", html, css, assets };
}
