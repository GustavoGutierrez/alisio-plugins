/**
 * `@alisio/plugin-reportforge` — an editorial report studio.
 *
 * Registers the read-only tool `reportforge_reports`, the `help` command, the `rf-editor` agent
 * and `rf-design` skill, and (on hosts with plugin apps, Alisio 0.11.5+) the studio app.
 */
import { readFile } from "node:fs/promises";
import { definePlugin, type PluginAPI, type PluginAppAction, textResult } from "@alisio/sdk";
import { ACTIONS, createService, type ServiceDeps } from "./service.js";
import { VERSION } from "./version.js";

export { fitScale, LEGIBLE_SCALE, PAGE_MARGIN_MM, printableArea } from "./fit.js";
export { GenerationError, parseAnswer, validateBlocks } from "./generate.js";
export { fitIsCurrent, renderReport } from "./render.js";
export { ACTIONS, createService } from "./service.js";
export { importPublicUrl, isPrivateAddress } from "./sources.js";
export { PALETTES, type Report } from "./types.js";
export { VERSION } from "./version.js";

/**
 * The studio frame. The build writes `dist/ui.html` (from `ui/index.html`, with `icon.svg` inlined
 * in the brand) next to this module; the fallback only runs from `src/` (tests, development) and
 * builds the same page with the same script, which is not shipped.
 */
export async function loadHtml(): Promise<string> {
  try {
    return await readFile(new URL("./ui.html", import.meta.url), "utf8");
  } catch {
    const builder = new URL("../scripts/copy-ui.mjs", import.meta.url).href;
    const { buildUi } = (await import(builder)) as {
      buildUi: (html: string, svg: string) => string;
    };
    return buildUi(
      await readFile(new URL("../ui/index.html", import.meta.url), "utf8"),
      await readFile(new URL("../icon.svg", import.meta.url), "utf8"),
    );
  }
}

const HELP =
  "ReportForge opens from the Apps group of your project (Alisio 0.11.6 or newer). / ReportForge se abre desde el grupo Aplicaciones de tu proyecto (Alisio 0.11.6 o posterior).";

export function createReportForgePlugin(options: Omit<ServiceDeps, "api"> = {}) {
  const disposers: Array<() => void> = [];
  return definePlugin({
    id: "alisio.reportforge",
    name: "ReportForge",
    version: VERSION,
    apiVersion: 1,
    description: "Editorial HTML/SVG reports and infographics from your sources, printable to PDF.",
    categories: ["tools", "ui"],
    setup(api: PluginAPI) {
      const service = createService({ ...options, api });
      api.resources.agents("../.agents/agents");
      api.resources.skills("../.agents/skills");
      disposers.push(
        api.commands.register("help", async () => HELP, {
          description: "Where to find ReportForge",
        }),
      );
      disposers.push(
        api.tools.register({
          name: "reportforge_reports",
          description:
            "List the ReportForge reports of the current workspace (name, type, last update).",
          effect: "read",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          async execute(_input, context) {
            if (!context.session) return textResult("ReportForge needs an active session.");
            return textResult(JSON.stringify(await service.listReports(context.session)));
          },
        }),
      );
      if (api.apps) {
        const actions: Record<string, PluginAppAction> = {};
        for (const [name, spec] of Object.entries(ACTIONS)) {
          actions[name] = {
            effect: spec.effect,
            inputSchema: spec.inputSchema,
            async handler(input, context) {
              try {
                const value = await service.run(
                  name,
                  input && typeof input === "object" ? (input as Record<string, unknown>) : {},
                  context.sessionId,
                );
                return { value };
              } catch (error) {
                const message = error instanceof Error ? error.message : "";
                return {
                  error: /^[a-z][a-z0-9_]{0,60}$/.test(message) ? message : "operation_failed",
                };
              }
            },
          };
        }
        disposers.push(
          api.apps.register({
            id: "reportforge",
            label: { en: "ReportForge", es: "Generador de informes" },
            html: loadHtml,
            actions,
            busy: service.busy,
            dispose: service.dispose,
          }),
        );
      }
      disposers.push(service.dispose);
    },
    dispose() {
      for (const stop of disposers.splice(0).reverse()) {
        try {
          stop();
        } catch {
          // best effort
        }
      }
    },
  });
}

export default createReportForgePlugin();
