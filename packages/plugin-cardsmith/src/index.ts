import { definePlugin, type PluginAPI } from "@alisio/sdk";
import { registerCardsmithTools } from "./integrations/alisio-tools.js";
import { VERSION } from "./version.js";

const disposers: Array<() => void> = [];

const plugin = definePlugin({
  id: "alisio.cardsmith",
  name: "Cardsmith",
  description:
    "Generates finished card images from chat requests: social cards, certificates, badges, banners, photo composites, charts and dynamic data cards.",
  categories: ["tools"],
  version: VERSION,
  apiVersion: 1,
  setup(api: PluginAPI): void {
    // Registration only: the skill file ships in a later work unit, next to the built entry.
    api.resources.skills("../.agents/skills");
    disposers.push(registerCardsmithTools(api));
  },
  dispose(): void {
    for (const dispose of disposers.splice(0).reverse()) dispose();
  },
});

export { registerCardsmithTools } from "./integrations/alisio-tools.js";
export default plugin;
