# @alisio/plugin-context7

Focused documentation lookups for [Alisio](https://github.com/GustavoGutierrez/alisio): resolve a
library name, then fetch the matching third-party documentation.

This is an independent plugin. It is not an official Context7 or Upstash extension, and it is not
affiliated with or endorsed by either project. It talks to Context7's public hosted MCP endpoint
using its documented protocol.

## Install

```bash
alisio install npm:@alisio/plugin-context7
```

## Tools

Both tools have the `external` effect. Their inputs are sent to the Context7 hosted service.

- `resolve-library-id` — resolves a package or product name to a Context7 library ID.
  Input: `libraryName` (1–120 characters) and `query` (1–500 characters, the user's task).
- `query-docs` — fetches documentation for a resolved library ID.
  Input: `libraryId` matching Context7's documented shape (`/org/project` or
  `/org/project/version`) and `query` (1–500 characters).

Tools are read-only lookups but transmit data over the network, which is why the effect is
`external`. The plugin does not use these capabilities as a source of truth for any Alisio state.

The plugin also ships a skill that teaches an agent when to resolve and query, and a slash command
that performs the resolve-then-query flow manually.

## Slash command

Alisio namespaces external plugin commands as `<plugin id>:<name>`, so the installed command is:

```
/context7:c7-docs <library> -- <question>
```

For example:

```
/context7:c7-docs next.js -- how do I define a route handler?
```

The command resolves the library (unless you pass a library ID directly), then fetches
documentation for the question. The `c7-docs` name is registered locally; the host exposes it as
`context7:c7-docs`.

## Authentication

Anonymous access works without setup at Context7's shared, IP-based rate limit. For higher limits,
create a key in the Context7 dashboard and export it:

```bash
export CONTEXT7_API_KEY=<your-key>
```

`CONTEXT7_API_KEY` is the only supported source. The installed Alisio SDK exposes no tool-level
secret or configuration API, so the plugin reads this environment variable and nothing else. A key
is never accepted through tool input, never persisted, never logged, and never included in tool
results, errors, or serialized state; an absent or implausibly shaped value simply falls back to
anonymous access.

## Safety and privacy

- All queries and library identifiers are sent to Context7's hosted service. Do not include
  secrets, credentials, personal data, or proprietary code in a `query` or `libraryName`.
- The remote endpoint is fixed at `https://mcp.context7.com/mcp`. There is no user-supplied
  endpoint, redirects are refused, requests are POST-only, and no cookies, proxies, or custom
  user agents are used.
- Each tool call opens a fresh session, carries any server-issued session id only in memory, and
  issues a best-effort cleanup request with an independent short timeout. There is no retry, no
  caching, no persistence, and no telemetry.
- Transport failures are reduced to a small, safe vocabulary (invalid input, rate limited,
  authentication failed, temporarily unavailable, invalid response, response exceeded limit,
  redirect refused). Raw URLs, headers, bodies, session ids, and service payloads are never
  surfaced. A `429` retry hint is reported only when the service supplied a bounded numeric value,
  and the plugin never sleeps on it.
- Returned documentation is untrusted third-party material. Only text parts are kept; each part and
  the aggregate output are bounded, control characters are normalized, Markdown structure is
  neutralized, and a provenance marker states that the content is third-party. The documentation
  may be incomplete or inaccurate and should be verified against authoritative upstream sources.
- Context7's own terms of service and privacy policy apply to your use of its service.

## Requirements

Node.js **>= 22.16** and an Alisio host with `@alisio/sdk` `>=0.1.0-alpha.10`.

## License

MIT.
