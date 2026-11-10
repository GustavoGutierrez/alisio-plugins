# @alisio/plugin-semantic

## 0.1.0

### Minor Changes

- 70307d4: Add `@alisio/plugin-semantic`: a local semantic search engine for Alisio's `api.semantic` ports (a LanceDB vector store and a `multilingual-e5-small` embedding provider whose ONNX Runtime and model are downloaded once, on request, and verified) plus the Notebook app, which answers questions only from your own sources (text, HTML, Word, PowerPoint, Excel and PDF) with checked citations, hybrid vector and keyword retrieval, a keyword-only mode when the engine is unavailable, and English/Spanish following Alisio's language.
