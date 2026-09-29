---
"@alisio/plugin-deepseek": patch
"@alisio/plugin-opencode": patch
"@alisio/plugin-opencode-go": patch
---

Moved the DeepSeek, OpenCode Console (Zen) and OpenCode Go model providers out of the Alisio
core repository into this monorepo, where each is versioned and published independently. They
are no longer built-in Alisio plugins: install them with `alisio install npm:@alisio/plugin-...`.