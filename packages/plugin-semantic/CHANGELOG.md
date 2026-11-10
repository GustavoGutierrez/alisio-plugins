# @alisio/plugin-semantic

## 0.1.1

### Patch Changes

- 522d120: Notebook fixes and improvements: answers render Markdown safely with clickable citation chips everywhere (and the model is told to cite as [n]); a per-notebook model selector with a visible fallback when the chosen model disappears; a clear "connect a model" state instead of failing questions; copy buttons (text or formatted) for answers, the guide and summaries; the guide, source summaries and ticked sources now persist; the "New notebook" card is centered. Fixes the Notebook disappearing from the Apps menu after a while ("This app is no longer available"): one workspace closing no longer unregisters the app of another, and the frame recovers from a transient host error instead of locking.

## 0.1.0

### Minor Changes

- 70307d4: Add `@alisio/plugin-semantic`: a local semantic search engine for Alisio's `api.semantic` ports (a LanceDB vector store and a `multilingual-e5-small` embedding provider whose ONNX Runtime and model are downloaded once, on request, and verified) plus the Notebook app, which answers questions only from your own sources (text, HTML, Word, PowerPoint, Excel and PDF) with checked citations, hybrid vector and keyword retrieval, a keyword-only mode when the engine is unavailable, and English/Spanish following Alisio's language.
