#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheRoot } from "./cache.js";
import { formatReport, loadProject, parseGates, runChecks } from "./checks/index.js";
import { formatBuild } from "./coordinator.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { buildThesis } from "./render/build.js";
import type { BuildScope } from "./render/model.js";
import { generateBibtex, writeBibtex } from "./research/bibtex.js";
import { readLibrary } from "./research/library.js";
import { readState } from "./storage.js";
import { checkStyleFiles, listStyles } from "./style-commands.js";
import { idPatterns } from "./types.js";
import { VERSION } from "./version.js";
import { writeCheckReport } from "./workspace.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

const usage = `alisio-thesis ${VERSION}

Usage:
  alisio-thesis check [dir] [--json] [--gate G0,G7] [--section SEC-id] [--no-write]
  alisio-thesis build [dir] [full|approved|SEC-id] [--pdfa] [--json]
  alisio-thesis bib [dir] [--check]
  alisio-thesis style list|check [dir] [--json]
  alisio-thesis doctor [--json]

check and build exit 0 on success, 1 when a check or the build fails and 2 on a usage or environment error.
style check validates workspace styles and profiles (CSL-001, PRF-001, CSL-010) and exits 1 on an error.
bib regenerates bibliography/references.bib from the evidence library (--check only compares and exits 1 on a difference).
dir is the thesis folder, or a workspace that contains thesis/ (default: the current directory).
`;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Find the thesis root for a directory argument; throws a usage error when there is none. */
export async function resolveThesisRoot(directory: string): Promise<string> {
  const absolute = resolve(directory);
  if (!(await isDirectory(absolute))) throw new Error(`Not a directory: ${directory}`);
  const state = await readState(absolute).catch(() => {
    throw new Error("The thesis state file is unreadable");
  });
  if (state) return join(absolute, state.root);
  if (await isFile(join(absolute, "thesis.yaml"))) return absolute;
  if (await isDirectory(join(absolute, "thesis"))) return join(absolute, "thesis");
  throw new Error(`No thesis folder found in ${directory} (expected thesis.yaml or thesis/)`);
}

export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.stdout(usage);
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "-v") {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  try {
    if (command === "doctor") {
      const json = rest.includes("--json");
      const unknown = rest.filter((arg) => arg !== "--json");
      if (unknown.length > 0) throw new Error(`Unexpected argument: ${unknown[0]}`);
      const report = await runDoctor();
      io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDoctor(report)}\n`);
      return 0;
    }
    if (command === "check") {
      let json = false;
      let write = true;
      let directory: string | undefined;
      const selectedGates: string[] = [];
      let section: string | undefined;
      for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index] as string;
        if (arg === "--json") json = true;
        else if (arg === "--section") {
          index += 1;
          section = rest[index];
          if (!section || !idPatterns.section.test(section))
            throw new Error("--section needs a section id such as SEC-03");
        } else if (arg === "--no-write") write = false;
        else if (arg === "--gate") {
          index += 1;
          const value = rest[index];
          if (!value) throw new Error("--gate needs a value such as G0 or G0,G7");
          selectedGates.push(...value.split(",").filter(Boolean));
        } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
        else if (directory === undefined) directory = arg;
        else throw new Error("Only one directory can be checked at a time");
      }
      const gates = parseGates(selectedGates);
      const root = await resolveThesisRoot(directory ?? io.cwd);
      // Section progress (EVD-010) lives in the workspace state, which sits above the thesis root.
      const state =
        (await readState(resolve(directory ?? io.cwd)).catch(() => undefined)) ??
        (await readState(resolve(root, "..")).catch(() => undefined));
      const report = runChecks(await loadProject(root, state ? { state } : {}), {
        gates,
        ...(section ? { section } : {}),
      });
      if (write) {
        await writeCheckReport(root, report).catch((error: Error) => {
          io.stderr(`warning: could not write build/check-report.json: ${error.message}\n`);
        });
      }
      io.stdout(json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report)}\n`);
      return report.ok ? 0 : 1;
    }
    if (command === "build") {
      let json = false;
      let pdfa = false;
      let html = false;
      let scope: BuildScope = "full";
      let section: string | undefined;
      let directory: string | undefined;
      for (const arg of rest) {
        if (arg === "--json") json = true;
        else if (arg === "--pdfa") pdfa = true;
        else if (arg === "--html") html = true;
        else if (arg === "full" || arg === "approved") scope = arg;
        else if (idPatterns.section.test(arg)) {
          scope = "section";
          section = arg;
        } else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
        else if (directory === undefined) directory = arg;
        else throw new Error("Only one directory can be built at a time");
      }
      const root = await resolveThesisRoot(directory ?? io.cwd);
      const state =
        (await readState(resolve(directory ?? io.cwd)).catch(() => undefined)) ??
        (await readState(resolve(root, "..")).catch(() => undefined));
      const env = io.env ?? process.env;
      const outcome = await buildThesis({
        root,
        scope,
        ...(section ? { section } : {}),
        ...(pdfa ? { pdfa: true } : {}),
        ...(html ? { format: "html" } : {}),
        ...(state ? { sections: state.sections } : {}),
        env,
        cacheRoot: cacheRoot(undefined, env),
      });
      io.stdout(json ? `${JSON.stringify(outcome, null, 2)}\n` : `${formatBuild(outcome)}\n`);
      return outcome.ok ? 0 : 1;
    }
    if (command === "style") {
      const [sub, ...args] = rest;
      if (sub !== "list" && sub !== "check")
        throw new Error("Usage: style list|check [dir] [--json]");
      let json = false;
      let directory: string | undefined;
      for (const arg of args) {
        if (arg === "--json") json = true;
        else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
        else if (directory === undefined) directory = arg;
        else throw new Error("Only one directory can be processed at a time");
      }
      const root = await resolveThesisRoot(directory ?? io.cwd);
      const project = await loadProject(root);
      const env = io.env ?? process.env;
      if (sub === "list") {
        io.stdout(`${listStyles(project)}\n`);
        return 0;
      }
      const result = await checkStyleFiles(project, { env, cacheRoot: cacheRoot(undefined, env) });
      io.stdout(json ? `${JSON.stringify(result.report, null, 2)}\n` : `${result.text}\n`);
      return result.report.ok ? 0 : 1;
    }
    if (command === "bib") {
      let check = false;
      let directory: string | undefined;
      for (const arg of rest) {
        if (arg === "--check") check = true;
        else if (arg.startsWith("--")) throw new Error(`Unknown option ${arg}`);
        else if (directory === undefined) directory = arg;
        else throw new Error("Only one directory can be processed at a time");
      }
      const root = await resolveThesisRoot(directory ?? io.cwd);
      const records = await readLibrary(root);
      const fresh = generateBibtex(records);
      const path = join(root, "bibliography", "references.bib");
      const current = await readFile(path, "utf8").catch(() => undefined);
      if (check) {
        const same = current === fresh;
        io.stdout(
          same
            ? "references.bib is up to date\n"
            : "references.bib differs from the library (CIT-004)\n",
        );
        return same ? 0 : 1;
      }
      await writeBibtex(root, records);
      io.stdout(
        `${current === fresh ? "references.bib already up to date" : "Wrote bibliography/references.bib"} (${records.length} record(s))\n`,
      );
      return 0;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    return 2;
  }
}

function invokedDirectly(): boolean {
  try {
    const entry = process.argv[1];
    return (
      Boolean(entry) &&
      realpathSync(entry as string) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    cwd: process.cwd(),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 2;
    },
  );
}
