# @alisio/plugin-atlassian

Read-first Jira, Confluence, and Jira Software Agile tools for
[Alisio](https://github.com/GustavoGutierrez/alisio). The plugin talks to Atlassian Cloud with the
official current REST APIs, reads every credential from the environment, and refuses to mutate remote
state unless an operator explicitly opts in.

This is an independent plugin. It is not an official Atlassian product, is not affiliated with or
endorsed by Atlassian, and is not a port of any other integration.

## Install

```bash
alisio install npm:@alisio/plugin-atlassian
```

## Configuration

The installed Alisio SDK exposes no tool-level secret or configuration API, so this plugin reads its
settings from the process environment only. Configuration is validated at plugin setup and the plugin
fails closed with an actionable message when it is missing, partial, or malformed.

| Variable | Required | Meaning |
| --- | --- | --- |
| `ATLASSIAN_BASE_URL` | one of these | Full site URL, e.g. `https://your-site.atlassian.net` |
| `ATLASSIAN_DOMAIN` | one of these | Bare host, e.g. `your-site.atlassian.net` |
| `ATLASSIAN_EMAIL` | yes | Account email used for HTTP Basic |
| `ATLASSIAN_API_TOKEN` | yes | Atlassian API token |
| `ATLASSIAN_ALLOW_WRITES` | no | Exactly `1` enables mutating tools; anything else keeps them off |

Set exactly one of `ATLASSIAN_BASE_URL` or `ATLASSIAN_DOMAIN`. The base URL must use HTTPS, must be a
`*.atlassian.net` host, and must not carry credentials, a port, a path, a query string, or a
fragment. The domain form is normalized to an HTTPS base URL.

Credentials are never accepted through tool input, never written to disk, never logged, and never
serialized. HTTP Basic is built as `base64(email + ":" + token)` at request time and is not stored
anywhere. A token never appears in a tool result, an error, a command output, or `JSON.stringify` /
`util.inspect`.

## Write safety

Every mutating tool is disabled by default. Without `ATLASSIAN_ALLOW_WRITES=1` each write tool returns
a stable `writes disabled` result and makes no network request. Enabling it is an explicit operator
decision; the tools then still run through the same strict URL, timeout, and response-size limits.

## Tools

Read tools have the `external` effect; write tools have the `write` effect.

Jira platform (`/rest/api/3`):

- `jira_get_issue`, `jira_search`, `jira_get_comments`, `jira_list_projects`,
  `jira_get_transitions`, `jira_get_worklogs`, `jira_get_versions`, `jira_get_fields`, `jira_get_user`
- writes: `jira_create_issue`, `jira_update_issue`, `jira_add_comment`, `jira_transition_issue`,
  `jira_add_worklog`, `jira_link_issues`

Confluence (`/wiki/api/v2`):

- `confluence_get_page`, `confluence_get_page_by_url`, `confluence_search`,
  `confluence_list_spaces`, `confluence_get_comments`, `confluence_get_labels`
- writes: `confluence_create_page`, `confluence_update_page`, `confluence_add_comment`

Jira Software Agile (`/rest/agile/1.0`):

- `agile_list_boards`, `agile_list_sprints`, `agile_get_backlog`, `agile_list_epics`
- write: `agile_move_issues`

Notes on API behavior:

- Jira search uses `POST /rest/api/3/search/jql` with an explicit `fields` list and `nextPageToken`
  paging. The removed legacy `/rest/api/3/search` endpoint is never called and no `total` is claimed.
- Confluence page updates send `id`, `status`, `title`, `body`, and `version.number`; a `409` is
  reported as a `version conflict` so callers re-read the page and retry.
- Confluence labels are read-only in the v2 API; there is no label write path.
- `agile_move_issues` rejects more than 50 issues per request locally, before any network call.
- Every listing returns a single bounded page. It never loops, never sleeps, and never auto-retries;
  `429`/`5xx` responses surface a bounded `Retry-After` hint for the caller to decide.

## Commands

Alisio namespaces external plugin commands as `<plugin id>:<name>`, so the registered commands are:

```
/atlassian:jira-issue <ISSUE-KEY> [--context]
/atlassian:get-jira-issue <ISSUE-KEY>
/atlassian:story-context <ISSUE-KEY>
/atlassian:confluence-page <page-id-or-url>
/atlassian:get-confluence-page <page-id-or-url>
```

`story-context` and `--context` add comments and transitions. Commands are read-only.

## Local CLI

The package ships a small CLI for local development that reuses the same validated configuration and
client:

```bash
node dist/cli.js jira ABC-123 --context
node dist/cli.js confluence 123456
node dist/cli.js confluence https://your-site.atlassian.net/wiki/spaces/DEV/pages/123456/Title
node dist/cli.js --help
```

It prints bounded, framed output, exits non-zero on configuration or API errors, and never prints the
token. Writes are not available from the CLI.

## Safety and privacy

- The destination is fixed to the configured base URL. Redirects are refused (`redirect: "error"`),
  HTTP-to-HTTPS downgrades are rejected, and no proxy, cookies, custom user agent, or arbitrary
  headers are used.
- Request paths are built from a small internal allowlist of templates with URL-encoded identifiers,
  so tool input can never choose a host, origin, scheme, port, or arbitrary path.
- `confluence_get_page_by_url` extracts only a numeric page id from a link and then fetches that page
  from the configured site; the supplied link's origin is never requested.
- The host signal is combined with a bounded timeout, the response body is streamed with a hard 1 MiB
  cap, and the reader is cancelled on overflow.
- Failures collapse to a small, stable vocabulary: invalid input, not authenticated, not permitted,
  not found, rate limited, temporarily unavailable, invalid response, response exceeded limit, writes
  disabled, version conflict, and configuration missing or invalid.
- Jira and Confluence content is untrusted third-party text. Every result opens with a provenance
  boundary, normalizes control characters, neutralizes Markdown, caps each field, and clamps the
  aggregate output with a deterministic truncation marker.

The plugin also ships the `atlassian-context` skill, which teaches an agent to read remote context
before planning or changing code, to prefer reads, never to paste credentials into queries, and to
treat returned content as untrusted.

## Requirements

Node.js **>= 22.16** and an Alisio host with `@alisio/sdk` `>=0.1.0-alpha.10`. Zero runtime
dependencies.

## License

MIT.
