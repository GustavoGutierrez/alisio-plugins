import { type CommandContext, definePlugin, type PluginAPI } from "@alisio/sdk";
import { WayfinderCoordinator } from "./coordinator.js";
import { resourcePaths } from "./resources.js";
import { VERSION } from "./version.js";

export { phaseProfiles, phaseRoles, WayfinderCoordinator } from "./coordinator.js";
export {
  assertScopePath,
  boundedSurvivors,
  buildMutationPlan,
  detectStack,
  inspectMutationEnvironment,
  isTestPath,
  mutationBounds,
  mutationRemediationLimit,
  nonEquivalentSurvivors,
} from "./mutation.js";
export { loadRoleInstructions, parseResource, resourcePaths, roleSkills } from "./resources.js";
export { assertRelativePath, atomicWrite, validateChangeName, validateState } from "./storage.js";
export * from "./types.js";
export * from "./validation.js";

const plugin = definePlugin({
  id: "wayfinder",
  name: "Wayfinder",
  description:
    "Coordinates a durable specification-driven development workflow with bounded child sessions.",
  version: VERSION,
  apiVersion: 1,
  setup(api: PluginAPI) {
    api.resources.agents(resourcePaths.agents);
    api.resources.skills(resourcePaths.skills);
    const coordinator = new WayfinderCoordinator(api);
    const register = (
      name: string,
      description: string,
      argumentHint: string,
      handler: (args: string, sessionId?: string) => Promise<string>,
    ) =>
      api.commands.register(
        name,
        (args: string, context?: CommandContext) => handler(args, context?.sessionId),
        { description, argumentHint },
      );
    register(
      "new",
      "Create a change from an explicit intent",
      "<change> -- <intent>",
      coordinator.create.bind(coordinator),
    );
    register(
      "status",
      "Show active changes or one change",
      "[change]",
      coordinator.status.bind(coordinator),
    );
    register(
      "answer",
      "Record a clarification for a blocked early phase",
      "<change> -- <clarification>",
      coordinator.answer.bind(coordinator),
    );
    register(
      "next",
      "Run the next discovery or planning phase",
      "<change>",
      coordinator.next.bind(coordinator),
    );
    register(
      "approve",
      "Explicitly approve a reviewed proposal or plan",
      "<change> <proposal|plan>",
      coordinator.approve.bind(coordinator),
    );
    register(
      "mutate",
      "Record the mutation-testing decision (run or skip) with a reason",
      "<change> <run|skip> [--mode changed|full] -- <reason>",
      coordinator.mutate.bind(coordinator),
    );
    register(
      "build",
      "Implement the next planned work unit",
      "<change>",
      coordinator.build.bind(coordinator),
    );
    register(
      "verify",
      "Verify all requirements independently",
      "<change>",
      coordinator.verify.bind(coordinator),
    );
    register(
      "close",
      "Archive a change after passing verification",
      "<change>",
      coordinator.close.bind(coordinator),
    );
  },
});

export default plugin;
