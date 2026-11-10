import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { VERSION } from "../../src/version.js";
import { harness, PROFILE_ANSWERS, ROUND2, ROUND3, scratchDir } from "./harness.js";

/** Every command and tool of the chat surface on one fixture workspace (EVL-APP-AC-01). */
export interface ChatRecord {
  outputs: Array<{ step: string; text: string; isError?: boolean }>;
  files: Record<string, string>;
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16),
]);

const fakePrinter = async () => ({
  pdf: Buffer.from("/Type /Page /Count 1"),
  engineVersion: "Chrome/test",
});

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out.sort();
}

/** The plugin version and the machine's browser path are the only environment-dependent values. */
const normalize = (text: string) =>
  text
    .replaceAll(VERSION, "<VERSION>")
    .replace(/^Browser: .*\n(PDFs need .*|PDF output is available\.)$/m, "Browser: <detected>");

/** Runs the whole chat surface (commands and tools) and records every text and file. */
export async function recordChatFlow(): Promise<ChatRecord> {
  const outputs: ChatRecord["outputs"] = [];
  const logo = join(await scratchDir(), "school.png");
  await writeFile(logo, PNG);
  const h = await harness({
    printer: fakePrinter,
    answers: [
      PROFILE_ANSWERS,
      { topic: "algebra/algebraic-expressions", grade: "septimo", level: "basico" },
      ROUND2,
      ROUND3,
    ],
  });
  const run = async (step: string, name: string, args = "") => {
    try {
      outputs.push({ step, text: normalize(await h.run(name, args)) });
    } catch (error) {
      outputs.push({ step, text: normalize((error as Error).message), isError: true });
    }
  };
  const tool = async (step: string, name: string, input: Record<string, unknown> = {}) => {
    const result = await h.tool(name, input);
    outputs.push({ step, text: normalize(result.text), isError: result.isError });
  };
  await run("status-empty", "status");
  await tool("evalua_status-empty", "evalua_status");
  await run("approve-a-without-draft", "approve", "a");
  await run("generate-without-exam", "generate");
  await run("build-without-exam", "build");
  await run("new", "new");
  await run("status-draft", "status");
  await tool("evalua_status-draft", "evalua_status");
  await tool("evalua_profile-get", "evalua_profile", { action: "get" });
  await tool("evalua_profile-set", "evalua_profile", { action: "set", subject: "Álgebra" });
  await tool("evalua_profile-logo", "evalua_profile", { action: "set", logoPath: logo });
  await tool("evalua_kb", "evalua_kb");
  await tool("evalua_check", "evalua_check");
  await run("kb", "kb");
  await run("doctor", "doctor");
  await run("init-existing", "init");
  await tool("evalua_exam-approve-a", "evalua_exam", { action: "approve", gate: "a" });
  await tool("evalua_exam-status", "evalua_exam", { action: "status" });
  await tool("evalua_exam-set-prompts", "evalua_exam", {
    action: "set-prompts",
    prompts: { "expression-evaluate": ["Evalúa la expresión: {expr}"] },
  });
  await tool("evalua_exam-set-prompts-unknown", "evalua_exam", {
    action: "set-prompts",
    prompts: { nope: ["x {expr}"] },
  });
  await tool("evalua_generate", "evalua_generate");
  await run("generate", "generate");
  await tool("evalua_build", "evalua_build");
  await run("build", "build");
  await run("approve-b", "approve", "b");
  await run("approve-bad", "approve", "c");

  // Headless continuation through evalua_answer on a second exam.
  h.setInteractive(false);
  await run("new-headless", "new");
  await tool("evalua_answer-bad", "evalua_answer", { answers: { bogus: "x" } });
  await tool("evalua_answer-1", "evalua_answer", {
    answers: { topic: "basic-math/fractions", grade: "septimo", level: "intermedio" },
  });
  await tool("evalua_answer-2", "evalua_answer", {
    answers: {
      types: ["single_choice"],
      count: "other",
      "count:text": "12",
      distribution: "bank",
      columns: "2",
    },
  });
  await tool("evalua_answer-2b", "evalua_answer", {
    answers: { bank_size: "default", variants: "3" },
  });
  await tool("evalua_answer-3", "evalua_answer", {
    answers: {
      pages: "2",
      time: "other",
      "time:text": "90 bolígrafo calculadora",
      closing: "quote",
      numbering: "section",
    },
  });
  await run("status-final", "status");

  const files: Record<string, string> = {};
  for (const path of await listFiles(h.workspace)) {
    const text = normalize((await readFile(path)).toString("latin1"));
    files[relative(h.workspace, path)] = createHash("sha256").update(text, "latin1").digest("hex");
  }
  return { outputs, files };
}
