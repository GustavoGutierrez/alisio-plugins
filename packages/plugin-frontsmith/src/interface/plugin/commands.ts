import type { CommandContext, PluginAPI } from "@alisio/sdk";
import type { RulesService } from "../../application/rules/rules-service.js";
import { isPackId } from "../../domain/ids.js";
import { code } from "../presenters/markdown.js";
import { packTestMarkdown, ruleExplainMarkdown, rulesListMarkdown } from "../presenters/rules.js";

const RULES_USAGE = [
  "Usage:",
  `- ${code("/frontsmith:rules list [pack]")} lists the active rules`,
  `- ${code("/frontsmith:rules explain <ruleId>")} shows one rule and its resolution trail`,
  `- ${code("/frontsmith:rules test <packId>")} runs the fixtures of a workspace pack`,
  `- ${code("/frontsmith:rules promote <candidateId>")} adds a retrospective candidate to the local pack`,
].join("\n");

/** Resolve the workspace of the invoking session; commands never guess a directory. */
export function workspaceOf(api: PluginAPI, context: CommandContext | undefined): string {
  if (!context?.sessionId) throw new Error("No session is available to resolve the workspace");
  return api.sessions.workspace(context.sessionId);
}

export async function rulesCommand(
  rules: RulesService,
  workspace: string,
  args: string,
): Promise<string> {
  const [sub, target, ...rest] = args.trim().split(/\s+/).filter(Boolean);
  if (rest.length > 0) return RULES_USAGE;
  switch (sub) {
    case "list": {
      if (target !== undefined && !isPackId(target)) return RULES_USAGE;
      const { rules: list, context } = await rules.list(workspace, target);
      const note =
        context.problems.length > 0
          ? `\n\nProblems found while resolving rules:\n${context.problems.map((p) => `- ${p}`).join("\n")}`
          : "";
      return rulesListMarkdown(list, context, target) + note;
    }
    case "explain": {
      if (!target) return RULES_USAGE;
      const explained = await rules.explain(workspace, target);
      if (!explained.found)
        return `Unknown rule ${code(target)}. Use ${code("/frontsmith:rules list")} to see the rule ids.`;
      if (explained.state === "active")
        return ruleExplainMarkdown(explained.rule, "active", { trail: explained.rule.trail });
      if (explained.state === "inactive")
        return ruleExplainMarkdown(explained.rule, "inactive", { reason: explained.reason });
      return ruleExplainMarkdown(explained.rule, "disabled", { trail: explained.trail });
    }
    case "test": {
      if (!target || !isPackId(target)) return RULES_USAGE;
      const report = await rules.testPack(workspace, target);
      return report
        ? packTestMarkdown(report)
        : `No workspace pack ${code(target)} under .frontsmith/packs.`;
    }
    case "promote": {
      if (!target) return RULES_USAGE;
      const result = await rules.promote(workspace, target);
      return result.ok
        ? `Promoted ${code(result.ruleId)} into ${code(".frontsmith/packs/local/pack.json")}. Review and commit the change.`
        : result.reason;
    }
    default:
      return RULES_USAGE;
  }
}

export function registerRulesCommand(api: PluginAPI, rules: RulesService): void {
  api.commands.register(
    "rules",
    async (args, context) => rulesCommand(rules, workspaceOf(api, context), args),
    {
      description: "List, explain, test and promote rule packs",
      argumentHint: "list [pack] | explain <ruleId> | test <packId> | promote <candidateId>",
    },
  );
}
