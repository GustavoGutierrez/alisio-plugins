# @alisio/plugin-openrouter

OpenRouter model provider for Alisio (`openrouter`). Install with `alisio install npm:@alisio/plugin-openrouter`, then connect with an API key or `OPENROUTER_API_KEY`; a stored key wins over the environment variable.

`openrouter/free` is the documented catalog and provider fallback. Alisio's host must still choose the active model: the SDK has no registration-level default selection. The plugin streams text, tools, usage, safe provider-visible reasoning, and preserves opaque `reasoning_details` for continuation.

It uses the fixed `https://openrouter.ai/api/v1` endpoint and sends no default attribution headers in v1 to preserve user privacy. Model inventory is an in-memory cache only.

## License

MIT.
