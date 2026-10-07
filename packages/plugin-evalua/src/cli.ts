#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { detectChrome } from "./chrome/detect.js";
import { familyIds } from "./families/index.js";
import { loadKnowledge, shippedKnowledgeDir } from "./knowledge/index.js";

/** Standalone CLI: `alisio-evalua check|kb|doctor` (spec 14.1, 14.2). */

export interface CliIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

const USAGE = [
  "Usage: alisio-evalua <command>",
  "",
  "  check    run the deterministic knowledge-base checks (EVL-KB-*)",
  "  kb       print the packs, topics and levels as JSON",
  "  doctor   report the knowledge base health and the print browser",
].join("\n");

/** Runs a CLI command and returns its exit code; I/O is injectable for tests. */
export async function main(argv: readonly string[], io: CliIo = console): Promise<number> {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "-h" || command === "--help") {
    io.log(USAGE);
    return 0;
  }
  if (command === "kb" || command === "check") {
    const knowledge = await loadKnowledge({
      shippedDir: shippedKnowledgeDir(),
      families: familyIds,
    });
    if (command === "kb") {
      io.log(
        JSON.stringify(
          {
            ok: knowledge.report.ok,
            packs: knowledge.packs.map((pack) => ({
              id: pack.id,
              code: pack.code,
              topics: pack.topics.map((topic) => topic.fullId),
            })),
          },
          null,
          2,
        ),
      );
    } else {
      for (const finding of knowledge.report.results) {
        io.log(
          `${finding.severity.toUpperCase()} ${finding.id} ${finding.subject}: ${finding.message}`,
        );
      }
      io.log(knowledge.report.ok ? "check: ok" : "check: errors");
    }
    return knowledge.report.ok ? 0 : 1;
  }
  if (command === "doctor") {
    const detection = await detectChrome();
    const knowledge = await loadKnowledge({
      shippedDir: shippedKnowledgeDir(),
      families: familyIds,
    });
    io.log(`Knowledge base: ${knowledge.report.ok ? "ok" : "errors"}`);
    io.log(`Packs: ${knowledge.packs.map((pack) => pack.id).join(", ") || "none"}`);
    io.log(`Browser: ${detection.path ?? "not found"} (${detection.source})`);
    return 0;
  }
  io.error(`Unknown command: ${command}`);
  io.error(USAGE);
  return 2;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exit(await main(process.argv.slice(2)));
}
