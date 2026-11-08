---
"@alisio/plugin-atlassian": patch
"@alisio/plugin-brave-search": patch
"@alisio/plugin-cardsmith": patch
"@alisio/plugin-context7": patch
"@alisio/plugin-deepseek": patch
"@alisio/plugin-evalua": patch
"@alisio/plugin-frontsmith": patch
"@alisio/plugin-google-chat": patch
"@alisio/plugin-literature-research": patch
"@alisio/plugin-material-icons": patch
"@alisio/plugin-opencode": patch
"@alisio/plugin-opencode-go": patch
"@alisio/plugin-openrouter": patch
"@alisio/plugin-swarm": patch
"@alisio/plugin-telemetry": patch
"@alisio/plugin-thesis": patch
"@alisio/plugin-wayfinder": patch
"@alisio/plugin-web-search": patch
---

Widen the `@alisio/sdk` peer range to `>=0.9.0 <0.12.0` so the plugin installs alongside plugins built for `@alisio/sdk` 0.11 (caret ranges on 0.x pin a single minor and made npm reject mixed installs).
