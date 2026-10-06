/** `.frontsmith/budgets.json` (spec 10.6): schemaVersion 1, every key optional. */
export interface BudgetsConfig {
  schemaVersion: 1;
  bundle: {
    dir: string;
    entryGlobs: string[];
    cssGlobs: string[];
    maxInitialJsGzipKb: number | null;
    maxInitialCssGzipKb: number | null;
    maxDeltaGzipKb: number | null;
  };
  images: { globs: string[]; maxBytes: number; maxWidthPx: number };
  inlineData: { maxBytes: number };
}

export function defaultBudgets(): BudgetsConfig {
  return {
    schemaVersion: 1,
    bundle: {
      dir: "dist",
      entryGlobs: ["dist/assets/index-*.js"],
      cssGlobs: ["dist/assets/index-*.css"],
      maxInitialJsGzipKb: null,
      maxInitialCssGzipKb: null,
      maxDeltaGzipKb: 10,
    },
    images: {
      globs: ["public/**/*.{png,jpg,jpeg,webp,avif}", "src/**/*.{png,jpg,jpeg,webp,avif}"],
      maxBytes: 300_000,
      maxWidthPx: 2560,
    },
    inlineData: { maxBytes: 4096 },
  };
}

export interface BudgetDiagnostic {
  pointer: string;
  message: string;
}

export type BudgetsValidation =
  | { ok: true; config: BudgetsConfig }
  | { ok: false; diagnostics: BudgetDiagnostic[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Hand-written validation: unknown keys and wrong types are diagnostics, defaults fill the rest. */
export function validateBudgets(raw: unknown): BudgetsValidation {
  const diagnostics: BudgetDiagnostic[] = [];
  const fail = (pointer: string, message: string): void => {
    diagnostics.push({ pointer, message });
  };
  const config = defaultBudgets();
  if (!isRecord(raw))
    return { ok: false, diagnostics: [{ pointer: "", message: "must be an object" }] };
  if (raw.schemaVersion !== 1) fail("/schemaVersion", "must be 1");
  const keys = (
    source: Record<string, unknown>,
    pointer: string,
    allowed: readonly string[],
  ): void => {
    for (const key of Object.keys(source))
      if (!allowed.includes(key)) fail(`${pointer}/${key}`, "unknown key");
  };
  keys(raw, "", ["schemaVersion", "bundle", "images", "inlineData"]);
  const globList = (value: unknown, pointer: string): string[] | undefined => {
    if (
      !Array.isArray(value) ||
      !value.every(
        (v) =>
          typeof v === "string" &&
          v.length > 0 &&
          !v.includes("\\") &&
          !v.startsWith("/") &&
          !v.includes("..") &&
          !v.includes("\u0000"),
      )
    ) {
      fail(pointer, "must be an array of relative globs");
      return undefined;
    }
    return value as string[];
  };
  const limit = (value: unknown, pointer: string): number | null | undefined => {
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      fail(pointer, "must be null or a positive number");
      return undefined;
    }
    return value;
  };
  const count = (value: unknown, pointer: string): number | undefined => {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      fail(pointer, "must be a positive integer");
      return undefined;
    }
    return value;
  };
  if (raw.bundle !== undefined) {
    if (!isRecord(raw.bundle)) fail("/bundle", "must be an object");
    else {
      const b = raw.bundle;
      keys(b, "/bundle", [
        "dir",
        "entryGlobs",
        "cssGlobs",
        "maxInitialJsGzipKb",
        "maxInitialCssGzipKb",
        "maxDeltaGzipKb",
      ]);
      if (b.dir !== undefined) {
        const dirs = globList([b.dir], "/bundle/dir");
        if (dirs) config.bundle.dir = dirs[0] as string;
      }
      if (b.entryGlobs !== undefined)
        config.bundle.entryGlobs =
          globList(b.entryGlobs, "/bundle/entryGlobs") ?? config.bundle.entryGlobs;
      if (b.cssGlobs !== undefined)
        config.bundle.cssGlobs = globList(b.cssGlobs, "/bundle/cssGlobs") ?? config.bundle.cssGlobs;
      for (const key of ["maxInitialJsGzipKb", "maxInitialCssGzipKb", "maxDeltaGzipKb"] as const)
        if (b[key] !== undefined) {
          const value = limit(b[key], `/bundle/${key}`);
          if (value !== undefined) config.bundle[key] = value;
        }
    }
  }
  if (raw.images !== undefined) {
    if (!isRecord(raw.images)) fail("/images", "must be an object");
    else {
      keys(raw.images, "/images", ["globs", "maxBytes", "maxWidthPx"]);
      if (raw.images.globs !== undefined)
        config.images.globs = globList(raw.images.globs, "/images/globs") ?? config.images.globs;
      if (raw.images.maxBytes !== undefined)
        config.images.maxBytes =
          count(raw.images.maxBytes, "/images/maxBytes") ?? config.images.maxBytes;
      if (raw.images.maxWidthPx !== undefined)
        config.images.maxWidthPx =
          count(raw.images.maxWidthPx, "/images/maxWidthPx") ?? config.images.maxWidthPx;
    }
  }
  if (raw.inlineData !== undefined) {
    if (!isRecord(raw.inlineData)) fail("/inlineData", "must be an object");
    else {
      keys(raw.inlineData, "/inlineData", ["maxBytes"]);
      if (raw.inlineData.maxBytes !== undefined)
        config.inlineData.maxBytes =
          count(raw.inlineData.maxBytes, "/inlineData/maxBytes") ?? config.inlineData.maxBytes;
    }
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, config };
}

/** Sizes in bytes and in KiB with one decimal (spec 10.6). */
export const kib = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KiB`;

export interface BudgetBaseline {
  initialJsGzipBytes?: number;
  initialCssGzipBytes?: number;
}

export interface BudgetMeasurement {
  initialJsGzipBytes: number;
  initialCssGzipBytes: number;
  /** Files the entry and css globs matched. */
  entryFiles: string[];
  cssFiles: string[];
}

export type BudgetStatus = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";

export interface BudgetLine {
  id: "initialJs" | "initialCss" | "delta" | "images" | "inlineData";
  status: BudgetStatus;
  summary: string;
}

/**
 * Evaluate the bundle limits (spec 10.6). A `null` absolute limit is not checked (no universal
 * numbers are invented). The delta needs a recorded baseline: without one it is BLOCKED at L2 and
 * above when a limit is set, otherwise SKIPPED.
 */
export function evaluateBundle(input: {
  config: BudgetsConfig;
  measured: BudgetMeasurement | undefined;
  baseline: BudgetBaseline | undefined;
  strict: boolean;
}): BudgetLine[] {
  const { config, measured, baseline } = input;
  const lines: BudgetLine[] = [];
  const absolute = (
    id: "initialJs" | "initialCss",
    limitKb: number | null,
    bytes: number | undefined,
    files: string[] | undefined,
  ): void => {
    if (limitKb === null) {
      lines.push({ id, status: "SKIPPED", summary: "no absolute limit set" });
      return;
    }
    if (bytes === undefined || !files || files.length === 0) {
      lines.push({ id, status: "BLOCKED", summary: "no build output matches the globs" });
      return;
    }
    lines.push(
      bytes > limitKb * 1024
        ? { id, status: "FAIL", summary: `${kib(bytes)} gzip exceeds ${limitKb} KiB` }
        : { id, status: "PASS", summary: `${kib(bytes)} gzip within ${limitKb} KiB` },
    );
  };
  absolute(
    "initialJs",
    config.bundle.maxInitialJsGzipKb,
    measured?.initialJsGzipBytes,
    measured?.entryFiles,
  );
  absolute(
    "initialCss",
    config.bundle.maxInitialCssGzipKb,
    measured?.initialCssGzipBytes,
    measured?.cssFiles,
  );
  const delta = config.bundle.maxDeltaGzipKb;
  if (delta === null)
    lines.push({ id: "delta", status: "SKIPPED", summary: "no maxDeltaGzipKb set" });
  else if (!baseline)
    lines.push({
      id: "delta",
      status: input.strict ? "BLOCKED" : "SKIPPED",
      summary: "no budgets.baseline.json recorded",
    });
  else if (!measured)
    lines.push({ id: "delta", status: "BLOCKED", summary: "no build output to compare" });
  else {
    const growth =
      measured.initialJsGzipBytes +
      measured.initialCssGzipBytes -
      ((baseline.initialJsGzipBytes ?? 0) + (baseline.initialCssGzipBytes ?? 0));
    lines.push(
      growth > delta * 1024
        ? {
            id: "delta",
            status: "FAIL",
            summary: `grew by ${kib(growth)} gzip (limit ${delta} KiB)`,
          }
        : {
            id: "delta",
            status: "PASS",
            summary: `${growth >= 0 ? "grew" : "shrank"} by ${kib(Math.abs(growth))} gzip (limit ${delta} KiB)`,
          },
    );
  }
  return lines;
}
