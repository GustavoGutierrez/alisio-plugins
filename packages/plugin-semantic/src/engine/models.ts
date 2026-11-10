import { SemanticPluginError } from "../errors.js";

/** One file of a pinned model snapshot; `sha256` is checked before the file is ever used (D3). */
export interface ModelFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ModelSpec {
  /** Value of `options.model`. */
  key: string;
  label: string;
  /** Hugging Face repository holding the ONNX export. */
  repo: string;
  /** Upstream model the export was converted from (shown in docs and notices). */
  baseModel: string;
  license: string;
  /** Pinned commit of `repo`. */
  revision: string;
  dtype: "q8";
  /** Declared size; the downloaded `config.json` (`hidden_size`) must agree. */
  dimensions: number;
  /** Model window in tokens, special tokens included. */
  maxTokens: number;
  prefixes: { query: string; document: string };
  files: ModelFile[];
}

const E5 = { query: "query: ", document: "passage: " };
const ONNX = "onnx/model_quantized.onnx";

/**
 * Curated table (§6.3, Q2: no free-form repository ids). Revisions and digests were read from the
 * real downloads and the Hugging Face LFS metadata on 2026-11-10. The `Xenova/*` repositories are
 * the ONNX conversions of the upstream models that transformers.js itself loads for `dtype: "q8"`.
 */
export const MODELS: Record<string, ModelSpec> = {
  "e5-small": {
    key: "e5-small",
    label: "multilingual-e5-small (q8)",
    repo: "Xenova/multilingual-e5-small",
    baseModel: "intfloat/multilingual-e5-small",
    license: "MIT",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    dtype: "q8",
    dimensions: 384,
    maxTokens: 512,
    prefixes: E5,
    files: [
      {
        path: "config.json",
        bytes: 658,
        sha256: "cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1",
      },
      {
        path: "tokenizer_config.json",
        bytes: 443,
        sha256: "a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b",
      },
      {
        path: "tokenizer.json",
        bytes: 17_082_730,
        sha256: "0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39",
      },
      {
        path: ONNX,
        bytes: 118_308_185,
        sha256: "f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193",
      },
    ],
  },
  "e5-base": {
    key: "e5-base",
    label: "multilingual-e5-base (q8)",
    repo: "Xenova/multilingual-e5-base",
    baseModel: "intfloat/multilingual-e5-base",
    license: "MIT",
    revision: "1ec9243030a27d1a115d5c340572074c125b58b2",
    dtype: "q8",
    dimensions: 768,
    maxTokens: 512,
    prefixes: E5,
    files: [
      {
        path: "config.json",
        bytes: 686,
        sha256: "4c27930e59106027abab56f7531c1fa6b14bbf31e8229ec36d68affa4e869bcd",
      },
      {
        path: "tokenizer_config.json",
        bytes: 418,
        sha256: "efb5c0d09722e5fe59a462cd2a9976ee216d55b037597d997cd3fe833216da15",
      },
      {
        path: "tokenizer.json",
        bytes: 17_082_660,
        sha256: "62c24cdc13d4c9952d63718d6c9fa4c287974249e16b7ade6d5a85e7bbb75626",
      },
      {
        path: ONNX,
        bytes: 278_647_662,
        sha256: "df7a9a29309e3ad491e1783adf8baee710262cc06079c7cbab63c630277fac94",
      },
    ],
  },
  minilm: {
    key: "minilm",
    label: "paraphrase-multilingual-MiniLM-L12-v2 (q8)",
    repo: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
    baseModel: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
    license: "Apache-2.0",
    revision: "2c4055b12046f11709e9df2c122e59ffbdc2f900",
    dtype: "q8",
    dimensions: 384,
    maxTokens: 128,
    prefixes: { query: "", document: "" },
    files: [
      {
        path: "config.json",
        bytes: 673,
        sha256: "05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7",
      },
      {
        path: "tokenizer_config.json",
        bytes: 496,
        sha256: "3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2",
      },
      {
        path: "tokenizer.json",
        bytes: 17_082_913,
        sha256: "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441",
      },
      {
        path: ONNX,
        bytes: 118_308_126,
        sha256: "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc",
      },
    ],
  },
};

export const DEFAULT_MODEL = "e5-small";

/** The model chosen by `options.model`; anything outside the table is `unknown_model`. */
export function resolveModel(option: unknown): ModelSpec {
  if (option === undefined || option === null) return MODELS[DEFAULT_MODEL] as ModelSpec;
  const spec =
    typeof option === "string" && Object.hasOwn(MODELS, option) ? MODELS[option] : undefined;
  if (!spec) throw new SemanticPluginError("unknown_model");
  return spec;
}

/** `<repo>@<revision>#<dtype>` (D6): any change makes the core reject old collections. */
export const modelId = (spec: ModelSpec) => `${spec.repo}@${spec.revision}#${spec.dtype}`;

export const totalBytes = (spec: ModelSpec) => spec.files.reduce((sum, f) => sum + f.bytes, 0);

/** Directory name of a model snapshot inside the cache. */
export const modelDirName = (spec: ModelSpec) => `${spec.key}-${spec.revision.slice(0, 12)}`;

/** Consumers never add prefixes (D7): the provider maps the kind to the family's prefix. */
export function applyPrefix(spec: ModelSpec, kind: "query" | "document", text: string): string {
  return `${spec.prefixes[kind]}${text}`;
}
