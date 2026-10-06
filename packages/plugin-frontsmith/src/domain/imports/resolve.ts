/** Pure import specifier resolution against a known set of workspace files (spec 10.3). */

export interface PathMapping {
  pattern: string;
  /** Targets relative to the workspace root (already joined with `baseUrl`). */
  targets: string[];
}

export interface ResolveContext {
  files: ReadonlySet<string>;
  paths: readonly PathMapping[];
  /** Workspace-relative directory used for bare specifiers, as in `compilerOptions.baseUrl`. */
  baseUrl?: string;
  /** `package.json#imports`. */
  packageImports: Readonly<Record<string, unknown>>;
}

export type ResolvedImport =
  | { kind: "file"; path: string; via: "relative" | "paths" | "baseUrl" | "package-imports" }
  | { kind: "package"; name: string }
  | { kind: "builtin" }
  | { kind: "unresolved"; reason: string };

const EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".vue",
  ".svelte",
  ".astro",
];
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};
const BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "sys",
  "timers",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/** Normalise `a/./b/../c` without touching the file system; `undefined` when it leaves the root. */
export function normalizePath(path: string): string | undefined {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

const dirname = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
};

export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  return parts[0] ?? specifier;
}

/** Try `base` as a file, with extensions, as a TS-mapped `.js` import, and as a directory index. */
function probe(base: string | undefined, files: ReadonlySet<string>): string | undefined {
  if (base === undefined) return undefined;
  if (files.has(base)) return base;
  const dot = base.lastIndexOf(".");
  const extension = dot > base.lastIndexOf("/") ? base.slice(dot) : "";
  const mapped = JS_TO_TS[extension];
  if (mapped) {
    const stem = base.slice(0, dot);
    for (const candidate of mapped) if (files.has(stem + candidate)) return stem + candidate;
  }
  for (const candidate of EXTENSIONS) if (files.has(base + candidate)) return base + candidate;
  for (const candidate of EXTENSIONS) {
    const index = `${base}/index${candidate}`;
    if (files.has(index)) return index;
  }
  return undefined;
}

function matchPattern(pattern: string, specifier: string): string | undefined {
  const star = pattern.indexOf("*");
  if (star === -1) return pattern === specifier ? "" : undefined;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (specifier.length < prefix.length + suffix.length) return undefined;
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function conditionTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = conditionTarget(entry);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ["import", "default", "node", "require"]) {
      const found = conditionTarget(record[key]);
      if (found) return found;
    }
    for (const entry of Object.values(record)) {
      const found = conditionTarget(entry);
      if (found) return found;
    }
  }
  return undefined;
}

export function resolveSpecifier(
  from: string,
  specifier: string,
  context: ResolveContext,
): ResolvedImport {
  // Built-ins are written `<scheme>:<name>`; only the `node` scheme exists.
  if (specifier.split(":", 1)[0] === "node" && specifier.includes(":")) return { kind: "builtin" };
  if (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier === "." ||
    specifier === ".."
  ) {
    const joined = normalizePath(`${dirname(from)}/${specifier}`);
    const found = probe(joined, context.files);
    return found
      ? { kind: "file", path: found, via: "relative" }
      : { kind: "unresolved", reason: `No file for ${specifier}` };
  }
  if (specifier.startsWith("#")) {
    let best: { pattern: string; capture: string; value: unknown } | undefined;
    for (const [pattern, value] of Object.entries(context.packageImports)) {
      const capture = matchPattern(pattern, specifier);
      if (capture !== undefined && (!best || pattern.length > best.pattern.length))
        best = { pattern, capture, value };
    }
    const target = best ? conditionTarget(best.value) : undefined;
    if (best && target) {
      const substituted = target.includes("*") ? target.replace("*", best.capture) : target;
      const found = probe(normalizePath(substituted), context.files);
      if (found) return { kind: "file", path: found, via: "package-imports" };
    }
    return { kind: "unresolved", reason: `No package imports entry for ${specifier}` };
  }
  let best: { mapping: PathMapping; capture: string } | undefined;
  for (const mapping of context.paths) {
    const capture = matchPattern(mapping.pattern, specifier);
    if (capture !== undefined && (!best || mapping.pattern.length > best.mapping.pattern.length))
      best = { mapping, capture };
  }
  if (best) {
    for (const target of best.mapping.targets) {
      const substituted = target.includes("*") ? target.replace("*", best.capture) : target;
      const found = probe(normalizePath(substituted), context.files);
      if (found) return { kind: "file", path: found, via: "paths" };
    }
    return { kind: "unresolved", reason: `No file for alias ${best.mapping.pattern}` };
  }
  if (context.baseUrl !== undefined) {
    const found = probe(normalizePath(`${context.baseUrl}/${specifier}`), context.files);
    if (found) return { kind: "file", path: found, via: "baseUrl" };
  }
  if (BUILTINS.has(packageNameOf(specifier))) return { kind: "builtin" };
  return { kind: "package", name: packageNameOf(specifier) };
}
