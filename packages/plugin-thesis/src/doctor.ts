import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { typstInstallDir } from "./cache.js";
import { type ChromeDetection, detectChrome } from "./chrome/detect.js";
import { packagePath } from "./package-paths.js";
import { parseTypstVersion, typstVersionOk } from "./render/adapters/typst-pdf/version.js";
import { typstPins, typstVersion } from "./typst-pins.js";

const execFileAsync = promisify(execFile);

export const vendoredPackages = [
  { name: "mitex", version: "0.2.7" },
  { name: "merman", version: "0.3.0" },
] as const;

export interface DoctorItem {
  id: string;
  label: string;
  status: "ok" | "warn" | "missing";
  detail: string;
}

export interface DoctorReport {
  items: DoctorItem[];
  /** True when a Typst engine or a Chrome fallback is available. */
  engineAvailable: boolean;
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  nodeVersion: string;
  exec(command: string, args: string[]): Promise<string>;
  exists(path: string): boolean;
  detectChrome(): Promise<ChromeDetection>;
  listCountries(): Promise<string[]>;
  packagePath(...segments: string[]): string;
  /** Engine cache root (where /thesis:setup installs Typst). */
  cacheRoot?: string;
}

const defaults = (): DoctorDeps => ({
  env: process.env,
  nodeVersion: process.versions.node,
  async exec(command, args) {
    const { stdout } = await execFileAsync(command, args, { encoding: "utf8", timeout: 5000 });
    return stdout;
  },
  exists: existsSync,
  detectChrome: () => detectChrome(),
  async listCountries() {
    try {
      return (await readdir(packagePath("policy-packs", "countries"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      return [];
    }
  },
  packagePath,
});

export {
  parseTypstVersion,
  requiredTypst,
  typstVersionOk,
} from "./render/adapters/typst-pdf/version.js";

async function typstItem(deps: DoctorDeps): Promise<DoctorItem> {
  const fromEnv = deps.env.ALISIO_THESIS_TYPST;
  let command = fromEnv || "typst";
  let where = fromEnv ? "ALISIO_THESIS_TYPST" : "PATH";
  if (!fromEnv && deps.cacheRoot) {
    // Resolution order: PATH first, then the binary installed by /thesis:setup.
    try {
      await deps.exec(command, ["--version"]);
    } catch {
      const pin = typstPins[`${process.platform}-${process.arch}`];
      const cached = pin
        ? join(typstInstallDir(deps.cacheRoot, typstVersion), pin.executable)
        : undefined;
      if (cached && deps.exists(cached)) {
        command = cached;
        where = "the setup cache";
      }
    }
  }
  try {
    const output = await deps.exec(command, ["--version"]);
    const version = parseTypstVersion(output);
    if (!version) {
      return {
        id: "typst",
        label: "Typst",
        status: "warn",
        detail: `Found via ${where} but the version could not be read`,
      };
    }
    const text = version.join(".");
    return typstVersionOk(version)
      ? { id: "typst", label: "Typst", status: "ok", detail: `${text} via ${where}` }
      : {
          id: "typst",
          label: "Typst",
          status: "warn",
          detail: `${text} via ${where} is older than the required 0.15.0`,
        };
  } catch {
    return {
      id: "typst",
      label: "Typst",
      status: "missing",
      detail: fromEnv
        ? "ALISIO_THESIS_TYPST is set but the binary could not be run"
        : "Not on PATH or in the setup cache. Run /thesis:setup, or set ALISIO_THESIS_TYPST to a Typst 0.15 binary",
    };
  }
}

export async function runDoctor(overrides: Partial<DoctorDeps> = {}): Promise<DoctorReport> {
  const deps = { ...defaults(), ...overrides };
  const items: DoctorItem[] = [];

  const [major = 0, minor = 0] = deps.nodeVersion.split(".").map(Number);
  items.push({
    id: "node",
    label: "Node.js",
    status: major > 22 || (major === 22 && minor >= 16) ? "ok" : "warn",
    detail: `${deps.nodeVersion} (requires >=22.16)`,
  });

  const typst = await typstItem(deps);
  items.push(typst);

  const chrome = await deps.detectChrome();
  items.push(
    chrome.browser
      ? {
          id: "chrome",
          label: "Chrome-family browser",
          status: "ok",
          detail: `Found (${chrome.source}); used as the PDF fallback when no Typst engine is available`,
        }
      : {
          id: "chrome",
          label: "Chrome-family browser",
          status: "missing",
          detail: "Not found; optional PDF fallback (the HTML preview needs no browser)",
        },
  );

  for (const { name, version } of vendoredPackages) {
    const present = deps.exists(deps.packagePath("typst-packages", "preview", name, version));
    items.push({
      id: `typst-package-${name}`,
      label: `Vendored Typst package ${name} ${version}`,
      status: present ? "ok" : "missing",
      detail: present ? "Present" : "Missing from the package",
    });
  }

  const globalPack = deps.exists(deps.packagePath("policy-packs", "global", "manifest.yaml"));
  const countries = await deps.listCountries();
  items.push({
    id: "policy-packs",
    label: "Policy packs",
    status: globalPack ? "ok" : "missing",
    detail: globalPack
      ? `global${countries.length ? ` + ${countries.join(", ")}` : " (no country packs yet)"}`
      : "The global pack is missing from the package",
  });
  const palettes = deps.exists(deps.packagePath("templates", "palettes.json"));
  items.push({
    id: "palettes",
    label: "Chart palettes",
    status: palettes ? "ok" : "missing",
    detail: palettes ? "templates/palettes.json present" : "templates/palettes.json is missing",
  });

  return { items, engineAvailable: typst.status === "ok" || chrome.browser !== null };
}

export function formatDoctor(report: DoctorReport): string {
  const lines = ["Thesis Studio doctor (report only; nothing was changed)"];
  for (const item of report.items) {
    lines.push(`${item.status.toUpperCase().padEnd(7)} ${item.label}: ${item.detail}`);
  }
  lines.push(
    report.engineAvailable
      ? "A PDF engine is available."
      : "No PDF engine is available. Run /thesis:setup to install the pinned Typst.",
  );
  return lines.join("\n");
}
