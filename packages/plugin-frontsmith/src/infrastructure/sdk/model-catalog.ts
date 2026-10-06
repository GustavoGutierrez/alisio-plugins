import type { PluginAPI } from "@alisio/sdk";
import type { ModelCatalog } from "../../application/ports/model-catalog.js";

/**
 * `api.models` as a catalog. Successful resolutions are cached for the life of the process
 * (spec 16.5); failures are not, because `/connect` can make a selector valid later.
 */
export class ApiModelCatalog implements ModelCatalog {
  private readonly resolved = new Map<string, string>();

  constructor(private readonly api: Pick<PluginAPI, "models">) {}

  async list(): Promise<string[]> {
    return (await this.api.models.list()).map((model) => model.reference);
  }

  async resolve(
    selector: string,
  ): Promise<{ ok: true; reference: string } | { ok: false; message: string }> {
    const cached = this.resolved.get(selector);
    if (cached !== undefined) return { ok: true, reference: cached };
    try {
      const { reference } = await this.api.models.resolve(selector);
      this.resolved.set(selector, reference);
      return { ok: true, reference };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }
}
