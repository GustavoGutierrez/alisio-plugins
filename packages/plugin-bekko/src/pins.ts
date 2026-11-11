/**
 * Pinned model files. Every download goes to exactly one of these URLs (an immutable Hugging Face
 * revision) and is accepted only when its size and SHA-256 match, so a moved branch, a mirror or a
 * tampered response is rejected instead of being loaded. The revisions are the ones `jev-web`
 * 0.9.2 pins for each variant; the digests were computed from those revisions.
 */
import type { Variant } from "./types.js";

export interface PinnedFile {
  url: string;
  bytes: number;
  sha256: string;
}

export interface VariantPin {
  model: string;
  revision: string;
  /** Total download size, shown to the user before setup. */
  bytes: number;
  files: PinnedFile[];
}

const TOKENIZER = {
  bytes: 3_583_327,
  sha256: "dd8374bb8bd74c2112989a24697e0ba494c6258ed758c0701a62957e67d38cea",
};

function pin(
  model: string,
  revision: string,
  manifest: Omit<PinnedFile, "url">,
  onnx: Omit<PinnedFile, "url">,
): VariantPin {
  const base = `https://huggingface.co/${model}/resolve/${revision}/onnx_browser/`;
  const files = [
    { url: `${base}manifest.json`, ...manifest },
    { url: `${base}tokenizer.json`, ...TOKENIZER },
    { url: `${base}model.onnx`, ...onnx },
  ];
  return { model, revision, bytes: files.reduce((sum, file) => sum + file.bytes, 0), files };
}

export const VARIANTS: Readonly<Record<Variant, VariantPin>> = {
  "68m": pin(
    "hotchpotch/bekko-system-one-v0-68m",
    "ab7685f23e5edbc1acb12ced4f2c4e12591efa69",
    { bytes: 881, sha256: "4889c2b2ffea857ad33d7577473cdb8ea82495a5d08c9ed3afe6b9cfa96f8759" },
    {
      bytes: 196_342_909,
      sha256: "3b121d68a67f9678a1272a08f24dd2ccffb276f92f39a3f77953b30290cbc3e1",
    },
  ),
  "17m": pin(
    "hotchpotch/bekko-system-one-v0-17m",
    "b886a1f9b91f4e8368d7830080d52d955e2c8dfa",
    { bytes: 880, sha256: "f8f3b0c8a7287ca58cf18a27376c68ef45adc834270e06cdc7f3d5952e5c5476" },
    {
      bytes: 29_023_607,
      sha256: "1a27d9ce0f44ddb8e3247aec245e3c05e2425996d5ff0def114a093c58c464de",
    },
  ),
};

export function isVariant(value: unknown): value is Variant {
  return value === "68m" || value === "17m";
}

/** Human-readable size, for status and setup messages. */
export function formatBytes(bytes: number): string {
  return bytes >= 1_000_000
    ? `${Math.round(bytes / 1_000_000)} MB`
    : `${Math.ceil(bytes / 1000)} kB`;
}
