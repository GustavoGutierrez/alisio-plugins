import { describe, expect, it } from "vitest";
import {
  applyPrefix,
  DEFAULT_MODEL,
  MODELS,
  modelId,
  resolveModel,
  totalBytes,
} from "../src/engine/models.js";
import { SemanticPluginError } from "../src/errors.js";

describe("model table", () => {
  it("gives e5-small q8 and e5-base different ids and dimensions (SEM-AC-04)", () => {
    const small = resolveModel("e5-small");
    const base = resolveModel("e5-base");
    expect(modelId(small)).not.toBe(modelId(base));
    expect(modelId(small)).toMatch(/^Xenova\/multilingual-e5-small@[0-9a-f]{40}#q8$/);
    expect(small.dimensions).toBe(384);
    expect(base.dimensions).toBe(768);
  });

  it("defaults to e5-small and rejects anything outside the curated table", () => {
    expect(resolveModel(undefined).key).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe("e5-small");
    for (const value of ["intfloat/multilingual-e5-small", "E5-SMALL", 7, "", "../x"])
      expect(() => resolveModel(value)).toThrow(SemanticPluginError);
    try {
      resolveModel("bge-m3");
    } catch (error) {
      expect((error as SemanticPluginError).code).toBe("unknown_model");
    }
  });

  it("pins every file to a revision, a size and a SHA-256 digest", () => {
    for (const spec of Object.values(MODELS)) {
      expect(spec.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(spec.files.map((f) => f.path)).toEqual(
        expect.arrayContaining(["config.json", "tokenizer.json", "onnx/model_quantized.onnx"]),
      );
      for (const file of spec.files) {
        expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(file.bytes).toBeGreaterThan(0);
        expect(file.path).not.toMatch(/\.\.|^\//);
      }
      expect(totalBytes(spec)).toBe(spec.files.reduce((sum, f) => sum + f.bytes, 0));
    }
    expect(totalBytes(MODELS["e5-small"]!)).toBe(135_392_016);
  });

  it("applies the e5 prefixes per kind and none for MiniLM (D7)", () => {
    const e5 = resolveModel("e5-small");
    expect(applyPrefix(e5, "query", "hola")).toBe("query: hola");
    expect(applyPrefix(e5, "document", "hola")).toBe("passage: hola");
    const minilm = resolveModel("minilm");
    expect(applyPrefix(minilm, "query", "hola")).toBe("hola");
    expect(applyPrefix(minilm, "document", "hola")).toBe("hola");
  });
});
