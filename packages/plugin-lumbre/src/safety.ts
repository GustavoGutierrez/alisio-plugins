// Validation of every untrusted name, path and file set (frame input and model output alike).
import { LumbreError } from "./errors.js";

export type Files = Record<string, string>;

export const LIMITS = {
  files: 150,
  fileBytes: 400_000,
  totalBytes: 3_000_000,
  pathChars: 200,
  depth: 8,
} as const;

/** Text file kinds a project may contain. TypeScript is excluded: Next.js would try to install it. */
const EXTENSIONS = new Set([
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "json",
  "md",
  "mdx",
  "txt",
  "svg",
  "astro",
  "xml",
  "webmanifest",
]);
/** Folders a project never authors: dependencies, build output and caches. */
const RESERVED_DIRS = new Set(["node_modules", "dist", "build", "out", "vendor"]);
const MANAGED_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "jsconfig.json",
  "tsconfig.json",
  "next-env.d.ts",
]);
const MANAGED_CONFIG =
  /^(vite|vitest|astro|next|postcss|tailwind|svelte|eslint|prettier|babel|webpack|rollup)\.config\.[a-z]+$/;

export function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw new LumbreError("invalid_input");
  return value;
}

/** A relative project file path; rejects anything that could escape or hide. */
export function filePath(value: unknown): string {
  if (typeof value !== "string") throw new LumbreError("invalid_path");
  const s = value;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected in paths.
  const bad = /[\\:\u0000-\u001f\u007f*?"<>|]/;
  if (!s || s.length > LIMITS.pathChars || bad.test(s) || s.startsWith("/"))
    throw new LumbreError("invalid_path");
  const parts = s.split("/");
  if (parts.length > LIMITS.depth) throw new LumbreError("invalid_path");
  for (const part of parts)
    if (
      !part ||
      part.startsWith(".") ||
      part.endsWith(" ") ||
      RESERVED_DIRS.has(part.toLowerCase())
    )
      throw new LumbreError("invalid_path");
  const ext = /\.([a-z0-9]+)$/i.exec(s)?.[1]?.toLowerCase();
  if (!ext || !EXTENSIONS.has(ext)) throw new LumbreError("invalid_path");
  return s;
}

/** True for files Lumbre owns: configuration, manifests, lockfiles and generated output. */
export function isManagedPath(path: string, generated: readonly string[]): boolean {
  const lower = path.toLowerCase();
  const base = lower.split("/").at(-1) ?? lower;
  if (generated.some((g) => g.toLowerCase() === lower)) return true;
  return MANAGED_NAMES.has(base) || MANAGED_CONFIG.test(base);
}

/** The lower-cased name shared by two paths that differ only in case (unsafe on macOS/Windows). */
export function sameCaseConflict(paths: Iterable<string>): string | undefined {
  const seen = new Set<string>();
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (seen.has(lower)) return lower;
    seen.add(lower);
  }
  return undefined;
}

/** A whole revision: bounded count and size, valid paths, no case collisions. */
export function validateFileSet(input: unknown): Files {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new LumbreError("invalid_input");
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > LIMITS.files) throw new LumbreError("too_large");
  const out: Files = {};
  let total = 0;
  for (const [name, value] of entries) {
    filePath(name);
    if (typeof value !== "string") throw new LumbreError("invalid_input");
    const bytes = Buffer.byteLength(value);
    if (bytes > LIMITS.fileBytes) throw new LumbreError("too_large");
    total += bytes;
    if (total > LIMITS.totalBytes) throw new LumbreError("too_large");
    out[name] = value;
  }
  if (sameCaseConflict(Object.keys(out))) throw new LumbreError("conflict");
  return out;
}

/** A relative folder under the workspace for "Export to my workspace". */
export function exportFolder(value: unknown): string {
  if (typeof value !== "string") throw new LumbreError("invalid_path");
  const s = value.trim();
  if (!s || s.length > 120) throw new LumbreError("invalid_path");
  const parts = s.split("/");
  if (parts.length > 4) throw new LumbreError("invalid_path");
  for (const part of parts)
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/.test(part) || part.endsWith(" "))
      throw new LumbreError("invalid_path");
  return s;
}

/** Process output safe to show: no terminal escapes, secret-looking values redacted, bounded. */
export function cleanLog(s: string, max = 16_000): string {
  return (
    s
      // biome-ignore lint/suspicious/noControlCharactersInRegex: strip terminal escape sequences.
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(
        /\b([A-Za-z_]*(?:token|password|secret|api[_-]?key)[A-Za-z_]*)(\s*[:=]\s*)\S+/gi,
        "$1$2[redacted]",
      )
      .slice(-max)
  );
}
