import type { Renderer } from "./port.js";

/** Renderer adapters by id, with the preferred adapter per format. */
export class RendererRegistry {
  private readonly renderers = new Map<string, Renderer>();

  register(renderer: Renderer): this {
    if (this.renderers.has(renderer.id))
      throw new Error(`Renderer already registered: ${renderer.id}`);
    this.renderers.set(renderer.id, renderer);
    return this;
  }

  get(id: string): Renderer | undefined {
    return this.renderers.get(id);
  }

  list(): Renderer[] {
    return [...this.renderers.values()];
  }

  /** Adapters producing a format, in registration order (the first is preferred). */
  byFormat(format: string): Renderer[] {
    return this.list().filter((renderer) => renderer.format === format);
  }
}
