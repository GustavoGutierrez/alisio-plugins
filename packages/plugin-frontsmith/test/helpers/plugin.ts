import { registerFrontsmith } from "../../src/index.js";
import { compose } from "../../src/interface/composition.js";
import { loadAgentProfile } from "../../src/resources.js";
import { createHarness } from "./harness.js";
import { NOW, workflowFixture } from "./workflow.js";

type Ui = Parameters<typeof createHarness>[1];

/** The plugin registered on a fake host over a workspace with a git baseline. */
export async function pluginFixture(
  options: {
    ui?: Ui;
    sessions?: Record<string, unknown>;
    files?: Record<string, string>;
    level?: "L0" | "L1" | "L2" | "L3";
  } = {},
) {
  const f = await workflowFixture(options.files ? { files: options.files } : {});
  const harness = createHarness(() => f.root, options.ui, options.sessions);
  const composition = compose({
    clock: { now: () => new Date(NOW) },
    runner: f.runner,
    process: f.proc,
    profiles: loadAgentProfile,
    version: "0.1.0",
    newId: (() => {
      let n = 0;
      return () => `id${++n}`;
    })(),
  });
  registerFrontsmith(harness.api, { composition });
  return { f, harness, composition };
}
