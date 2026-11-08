---
"@alisio/plugin-openai": minor
---

Add a sign-in-only `chatgpt` provider ("ChatGPT Plus/Pro") that uses OpenAI's official Sign in with ChatGPT flow through the host's native OAuth contract (`@alisio/sdk` 0.11): PKCE with the host loopback listener or a pasted redirect URL, token renewal, and revocation handling. The `openai` API-key provider is unchanged. The `@alisio/sdk` peer range is now `>=0.9.0 <0.12.0`.
