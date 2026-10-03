/**
 * Pinned runtime manifest. Everything setup installs or downloads is named here, so a pin bump
 * is a one-file change. Values were read from PyPI and the Hugging Face file listing for the
 * bundle repository; SHA-256 of non-LFS files was computed from the pinned revision.
 */
import type { LayaModel } from "../config.js";

export type ModelName = "english" | "multilingual" | "typed-decisions";

export interface ManifestFile {
  /** Path relative to the checkpoint directory (what Laya's digest check expects). */
  path: string;
  size: number;
  sha256: string;
}

export interface ModelPin {
  /** Subfolder of the bundle repository, absent for the root (English) checkpoint. */
  subfolder?: string;
  files: ManifestFile[];
}

export interface Manifest {
  schemaVersion: number;
  laya: { version: string; requirement: string; extra: string };
  python: { minMajor: number; minMinor: number };
  torch: { cpuIndexUrl: string };
  hub: { repo: string; revision: string };
  models: Record<ModelName, ModelPin>;
  hosts: readonly string[];
}

export const MANIFEST: Manifest = {
  schemaVersion: 1,
  laya: { version: "0.3.24", requirement: "laya[serve]==0.3.24", extra: "serve" },
  python: { minMajor: 3, minMinor: 10 },
  torch: { cpuIndexUrl: "https://download.pytorch.org/whl/cpu" },
  hub: { repo: "convaiinnovations/laya", revision: "55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851" },
  models: {
    multilingual: {
      subfolder: "multilingual",
      files: [
        {
          path: "model.safetensors",
          size: 643835514,
          sha256: "9d628fd971b700382ac6f65920a86f149777b2e748e0c955fb3b19695aa8f204",
        },
        {
          path: "encoder/config.json",
          size: 1938,
          sha256: "83f6916d13ef0f556ac461f28308dc2bffa7ebeadee8ec9e2db5812020ea5bb4",
        },
        {
          path: "rl_agent_config.json",
          size: 472,
          sha256: "25061739243b617ad88d1219ba6f8a9c86c5881ca28df024fa2d9b3b2fcc30c6",
        },
        {
          path: "tokenizer/tokenizer.json",
          size: 34363188,
          sha256: "609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f",
        },
        {
          path: "tokenizer/tokenizer_config.json",
          size: 524,
          sha256: "6c6b2d8e3c84ce0e671c129cd6b374b235d6f9863042a5836358d00a89bbb5a1",
        },
      ],
    },
    english: {
      files: [
        {
          path: "model.safetensors",
          size: 842609210,
          sha256: "891102d372688fc2a094dac56a384bc537b87c63f21f9f3dac0be2b7cbc8d86c",
        },
        {
          path: "encoder/config.json",
          size: 2083,
          sha256: "bf3ab80598fdccf414855a2ce80f22859e4492d06ca8a62ddd1cfb63972f8979",
        },
        {
          path: "rl_agent_config.json",
          size: 745,
          sha256: "ae287b56bbcf5f8c4f4541ae9dfd00c914c4c48b940b8398c3058af37ba92bbd",
        },
        {
          path: "tokenizer/tokenizer.json",
          size: 3583228,
          sha256: "6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30",
        },
        {
          path: "tokenizer/tokenizer_config.json",
          size: 308,
          sha256: "50044de60daaa73df97d262e15a40d4faf0160e7d742df64b377877a1320dd12",
        },
      ],
    },
    "typed-decisions": {
      subfolder: "typed-decisions",
      files: [
        {
          path: "model.safetensors",
          size: 842609220,
          sha256: "4fa56de72383a9d3efa9cfa78955733c81b9fc8067a587ca4beb82c78107a24e",
        },
        {
          path: "encoder/config.json",
          size: 2084,
          sha256: "5268d24ad3b77c8151de5dcb0762ba4391619aad9ab0bda33e36fb083cfeae6d",
        },
        {
          path: "rl_agent_config.json",
          size: 847,
          sha256: "ebf0cd524d92342a6be5e48e9fca3d7c2babfb5a56ccd79d2171ef5d8c7f7be8",
        },
        {
          path: "tokenizer/tokenizer.json",
          size: 3583228,
          sha256: "6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30",
        },
        {
          path: "tokenizer/tokenizer_config.json",
          size: 337,
          sha256: "08d4cf3ac4dca381759441b85b91a6d40e688471dcd33d15d6649eb0a9a854d1",
        },
      ],
    },
  },
  /** Hosts contacted during setup (and never afterwards). */
  hosts: ["pypi.org", "files.pythonhosted.org", "download.pytorch.org", "huggingface.co"],
};

/** Checkpoints a configured `model` value needs on disk. */
export function modelsToInstall(model: LayaModel): ModelName[] {
  return model === "auto" ? ["english", "multilingual"] : [model];
}

function pin(name: ModelName, manifest: Manifest): ModelPin {
  return manifest.models[name];
}

/** Repo-relative file paths for `snapshot_download(allow_patterns=...)`. */
export function allowPatterns(name: ModelName, manifest: Manifest = MANIFEST): string[] {
  const { subfolder, files } = pin(name, manifest);
  return files.map((f) => (subfolder ? `${subfolder}/${f.path}` : f.path));
}

export function checkpointBytes(name: ModelName, manifest: Manifest = MANIFEST): number {
  return pin(name, manifest).files.reduce((sum, f) => sum + f.size, 0);
}

/** Nested `LAYA_SHA256_DIGESTS` value: `{ checkpoint: { relativePath: sha256 } }`. */
export function digestsEnv(names: readonly ModelName[], manifest: Manifest = MANIFEST): string {
  const map: Record<string, Record<string, string>> = {};
  for (const name of names) {
    map[name] = Object.fromEntries(pin(name, manifest).files.map((f) => [f.path, f.sha256]));
  }
  return JSON.stringify(map);
}
