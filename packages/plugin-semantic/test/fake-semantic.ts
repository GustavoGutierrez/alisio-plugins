import type {
  SemanticDocument,
  SemanticSearchOptions,
  ToolSemantic,
  VectorMatch,
} from "@alisio/sdk";

class FakeSemanticError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "SemanticError";
    this.code = code;
  }
}

/**
 * In-memory `ToolSemantic`: word-overlap "similarity", per-collection model binding (so a model
 * change yields `model_mismatch` like the core), and an optional gate to pause `index` batches.
 */
export function fakeSemantic(options: { available?: boolean } = {}) {
  const collections = new Map<string, { modelId: string; docs: Map<string, SemanticDocument> }>();
  const state = {
    available: options.available ?? true,
    modelId: "fake@1#q8",
    indexCalls: 0,
    gate: undefined as Promise<void> | undefined,
    onIndex: undefined as (() => void) | undefined,
  };
  const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const check = (name: string) => {
    if (!state.available) throw new FakeSemanticError("unavailable");
    const c = collections.get(name);
    if (c && c.modelId !== state.modelId) throw new FakeSemanticError("model_mismatch");
    return c;
  };
  const search = async (name: string, query: string, o: SemanticSearchOptions = {}) => {
    const c = check(name);
    if (!c) return [];
    const q = words(query);
    const scored: VectorMatch[] = [];
    for (const doc of c.docs.values()) {
      if (o.filter && !Object.entries(o.filter).every(([k, v]) => doc.metadata?.[k] === v))
        continue;
      const w = words(doc.text);
      let overlap = 0;
      for (const x of q) if (w.has(x)) overlap++;
      if (overlap > 0)
        scored.push({
          id: doc.id,
          score: overlap / q.size,
          ...(doc.metadata ? { metadata: doc.metadata } : {}),
        });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, o.topK ?? 8);
  };
  const semantic: ToolSemantic = {
    available: () => state.available,
    active: () => ({
      embedding: state.available
        ? { id: "semantic.e5", modelId: state.modelId, dimensions: 4 }
        : null,
      store: state.available ? { id: "semantic.lance" } : null,
    }),
    embed: async (texts) => texts.map(() => new Float32Array(4)),
    async index(name, documents, o) {
      check(name);
      state.indexCalls++;
      state.onIndex?.();
      if (state.gate) await state.gate;
      o?.signal?.throwIfAborted();
      let c = collections.get(name);
      if (!c) {
        c = { modelId: state.modelId, docs: new Map() };
        collections.set(name, c);
      }
      for (const doc of documents) c.docs.set(doc.id, doc);
    },
    search,
    async trySearch(name, query, o) {
      try {
        return await search(name, query, o);
      } catch {
        return null;
      }
    },
    async remove(name, ids) {
      const c = check(name);
      for (const id of ids) c?.docs.delete(id);
    },
    async collections() {
      return [...collections.entries()].map(([name, c]) => ({
        name,
        modelId: c.modelId,
        dimensions: 4,
        count: c.docs.size,
      }));
    },
    async drop(name) {
      collections.delete(name);
    },
  };
  return {
    semantic,
    state,
    collections,
    ids: (name: string) => [...(collections.get(name)?.docs.keys() ?? [])],
  };
}
