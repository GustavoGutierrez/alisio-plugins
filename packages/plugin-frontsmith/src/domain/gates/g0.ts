import type { CommandName } from "../config/defaults.js";
import type { Level } from "../state/levels.js";
import { GateBuilder, type GateOutcome } from "./aggregate.js";

export interface G0Command {
  name: CommandName;
  resolved: boolean;
  /** `config` or `inferred:...`; empty when unresolved. */
  source: string;
}

export interface G0Input {
  level: Level;
  configProblems: string[];
  packProblems: string[];
  modelProblems: string[];
  architectureProblems: string[];
  /** A framework or a package manifest was found in the workspace. */
  stackDetected: boolean;
  commands: G0Command[];
  gitRepository: boolean;
}

/** Commands a level needs before work starts (spec 7.2 G0). */
export function requiredCommands(level: Level): CommandName[] {
  const base: CommandName[] = ["typecheck", "lint", "test"];
  if (level === "L2" || level === "L3") base.push("build");
  if (level === "L3") base.push("e2e");
  return base;
}

/** G0 Context: configuration, packs, models, stack, commands, architecture and git are all usable. */
export function gateG0(input: G0Input): GateOutcome {
  const b = new GateBuilder();
  b.problems("config", "CFG-000", input.configProblems, "config valid or absent", {
    severity: "blocker",
  });
  b.problems("packs", "PCK-000", input.packProblems, "rule packs load", { severity: "blocker" });
  b.problems("models", "FSM-000", input.modelProblems, "model configuration valid", {
    severity: "blocker",
  });
  b.problems(
    "architecture",
    "ARC-000",
    input.architectureProblems,
    "architecture config valid or absent",
    {
      severity: "blocker",
    },
  );
  if (input.stackDetected) b.add("stack", "PASS", "stack detected");
  else {
    b.add("stack", "BLOCKED", "no package manifest or framework detected");
    b.finding("stack", "G0-STACK", "blocker", "BLOCKED", "The stack could not be detected.", {
      fix: "Run Frontsmith from a frontend project (a package.json with its dependencies).",
    });
  }
  const needed = new Set(requiredCommands(input.level));
  for (const command of input.commands) {
    if (!needed.has(command.name)) continue;
    const id = `command:${command.name}`;
    if (command.resolved) b.add(id, "PASS", `resolved from ${command.source}`);
    else {
      b.add(id, "BLOCKED", `no ${command.name} command`);
      b.finding(
        id,
        "G0-CMD",
        "blocker",
        "BLOCKED",
        `The ${command.name} command is not configured or inferable.`,
        {
          fix: `Add a ${command.name} script to package.json or set commands.${command.name} in .frontsmith/config.json.`,
        },
      );
    }
  }
  if (input.gitRepository) b.add("git", "PASS", "git repository present");
  else if (input.level === "L0")
    b.add("git", "SKIPPED", "L0 may start without git; the unit diff checks will be BLOCKED", {
      required: false,
    });
  else {
    b.add("git", "BLOCKED", "not a git repository");
    b.finding("git", "G0-GIT", "blocker", "BLOCKED", "The workspace is not a git repository.", {
      fix: "Run git init, or work in a repository: diff guards and scope checks need git.",
    });
  }
  return b.outcome;
}
