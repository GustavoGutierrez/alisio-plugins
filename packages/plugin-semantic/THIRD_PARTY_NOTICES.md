# Third-party components

This package's own code is MIT licensed (see `LICENSE`). It depends on, bundles or downloads the
components below, which keep their own licenses.

## Runtime dependencies (installed by npm, not bundled)

- **LanceDB** (`@lancedb/lancedb` 0.30.0 and its per-platform native package): Apache-2.0.
  Source: https://github.com/lancedb/lancedb. Its peer dependency **Apache Arrow** (`apache-arrow`)
  is Apache-2.0.
- **Tokenizers.js** (`@huggingface/tokenizers` 0.2.0): Apache-2.0, Hugging Face.
  Source: https://github.com/huggingface/tokenizers.js. This is the tokenizer that transformers.js
  uses; the embedding pipeline (tokenize, mean pooling, L2 normalization) is reimplemented in this
  package on top of it and ONNX Runtime.

## Downloaded on request by `/semantic:setup` (never installed by npm or shipped here)

- **ONNX Runtime** (`onnxruntime-node` 1.30.0 and `onnxruntime-common` 1.30.0): MIT, Microsoft
  Corporation. Source: https://github.com/microsoft/onnxruntime. The pinned npm registry tarballs
  are verified against their sha512 integrity; only the JavaScript loaders and the current
  platform's CPU binaries (`onnxruntime_binding.node` and the ONNX Runtime shared library; on
  Windows also the DirectML libraries the package ships) are extracted into Alisio's cache. Install
  scripts are never run and the CUDA/TensorRT providers are never downloaded.

## Bundled into `dist/embedded.html`

- **PDF.js** (`pdfjs-dist` 6.5.438, including its worker): Apache-2.0, Mozilla Foundation.
  Source: https://github.com/mozilla/pdf.js. Used in the app frame to extract PDF text; no eval and
  no WebAssembly.

## Models (downloaded on request by `/semantic:setup`, never shipped in this package)

Files come from pinned revisions of Hugging Face repositories and are verified by SHA-256.

| Option | Downloaded from | Upstream model | License |
| --- | --- | --- | --- |
| `e5-small` (default) | `Xenova/multilingual-e5-small` | `intfloat/multilingual-e5-small` (Wang et al., "Multilingual E5 Text Embeddings", 2024) | MIT |
| `e5-base` | `Xenova/multilingual-e5-base` | `intfloat/multilingual-e5-base` | MIT |
| `minilm` | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` | `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` | Apache-2.0 |

The `Xenova/*` repositories hold ONNX conversions (with 8-bit quantized weights) of the upstream
models, published for transformers.js; they carry the upstream model license.
