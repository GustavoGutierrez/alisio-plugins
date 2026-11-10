---
title: "Google Chat"
description: "Google Chat tools with a send-only webhook mode and a full OAuth user mode, read-first defaults, and untrusted-content framing"
pageClass: "plugin-detail"
---

<PluginDetail slug="google-chat" />

Google Chat tools for [Alisio](https://github.com/GustavoGutierrez/alisio). The plugin offers two
independent, fail-closed authentication modes: a **send-only incoming webhook** with near-zero setup,
and an **OAuth user mode** that lists spaces and memberships, lists and searches messages, sends
messages, and edits or deletes messages the user owns.

This is an independent plugin. It is not an official Google product, is not affiliated with or
endorsed by Google, and is not a port of any other integration.

## Install

```bash
alisio install npm:@alisio/plugin-google-chat
```

## Two modes, and what each can do

| Capability | Webhook mode | OAuth user mode |
| --- | --- | --- |
| Send messages | yes | yes |
| Thread replies | yes | yes |
| List spaces | no | yes |
| List memberships | no | yes |
| List messages | no | yes |
| Search messages | no | yes (Developer Preview) |
| Edit message text | no | yes, text only |
| Delete messages | no | yes |

Reading, searching, editing, and deleting a space's history **cannot** be done with app
authentication (`chat.bot`). It requires user OAuth. The plugin never pretends otherwise: in webhook
mode a read, edit, or delete fails immediately with an actionable message and makes no network call.

### Webhook mode (near-zero setup)

Create an incoming webhook in the target space (in Google Chat: **Apps & integrations → Add
webhooks**) and export its URL. This needs no Google Cloud project and no OAuth client, but it is
send-only into that one space: a webhook cannot read, edit, delete, or react, and it is limited to
**1 request per second per space**, shared across every webhook in that space.

```bash
export GOOGLE_CHAT_WEBHOOK_URL='https://chat.googleapis.com/v1/spaces/AAAAAAAAAAA/messages?key=...&token=...'
```

### OAuth user mode (one-time setup)

There is **no zero-configuration way to read or edit Google Chat**. Enabling OAuth user mode is real
setup work, done once:

1. Create a Google Cloud project and **enable the Google Chat API**.
2. Configure an **OAuth consent screen** (Google Auth platform) and add the scopes you want the
   plugin to request as test scopes; add your account as a test user while the app is unpublished.
3. Create an **OAuth client of type "Desktop app"** and copy its client id and client secret.
4. Export the credentials and run the authorization command once in a browser:

```bash
export GOOGLE_CHAT_CLIENT_ID='...apps.googleusercontent.com'
export GOOGLE_CHAT_CLIENT_SECRET='...'
# then, from Alisio:
/google-chat:auth
```

`google-chat:auth` binds `127.0.0.1` on an ephemeral port, prints a Google authorization URL, receives
the browser redirect, validates the `state`, exchanges the code with PKCE, and writes the tokens
atomically. The browser callback is the only redirect; the plugin itself follows no redirects.

The device authorization grant **does not allow `chat.*` scopes** and the out-of-band copy/paste flow
is deprecated, so the loopback redirect with a Desktop OAuth client is the only supported flow here.

## Configuration

The installed Alisio SDK exposes no tool-level secret or configuration API, so this plugin reads its
settings from the process environment only. A partially configured OAuth mode is rejected at setup.

| Variable | Required | Meaning |
| --- | --- | --- |
| `GOOGLE_CHAT_WEBHOOK_URL` | for webhook mode | Official `https://chat.googleapis.com/v1/spaces/{space}/messages?key=...&token=...` webhook |
| `GOOGLE_CHAT_CLIENT_ID` | for OAuth mode | Desktop OAuth client id |
| `GOOGLE_CHAT_CLIENT_SECRET` | for OAuth mode | Desktop OAuth client secret |
| `GOOGLE_CHAT_SCOPES` | no | Space/comma-separated Chat scopes; only `https://www.googleapis.com/auth/chat.*` is accepted |
| `GOOGLE_CHAT_TOKEN_FILE` | no | Token file override; defaults to `configHome/google-chat/token.json` |
| `GOOGLE_CHAT_AUTH_TIMEOUT_MS` | no | Bounds the loopback wait (10000–900000; default 300000) |

The default scopes are `chat.messages` (send, edit, delete, list, search), `chat.spaces.readonly`, and
`chat.memberships.readonly`.

The Alisio config home (`configHome`) resolves as `ALISIO_CONFIG_HOME`, then
`$XDG_CONFIG_HOME/alisio`, then
`~/.config/alisio`, matching the rest of the monorepo.

## Token storage and revocation

Access token, refresh token, expiry, and granted scopes are stored at
`configHome/google-chat/token.json`, written atomically with `0600` and a `0700` parent. **The client
secret is never stored there**; it comes from the environment at exchange and refresh time. Tokens are
never logged, printed, serialized into a result, or returned by a command.

The plugin refreshes automatically when a token is within 60 seconds of expiry and once more on a
`401`; each refresh is bounded and persisted atomically. Revoking an access token on Google's
revocation endpoint **also invalidates its refresh token for the whole OAuth client**, so a revoked
store cannot be refreshed: the next call reports `not authenticated` and the stale file is cleared, and
you run `google-chat:auth` again. Revoke at `https://oauth2.googleapis.com/revoke` if you need to
invalidate credentials.

## Tools

Read tools have the `external` effect; mutations have the `write` effect.

- `google_chat_list_spaces` — spaces the user belongs to, optional `spaceType`, paged.
- `google_chat_list_messages` — messages in one space, with `filter`, `orderBy`, `showDeleted`, paged.
- `google_chat_search_messages` — Chat search across accessible spaces; optional `sender` (an email,
  user id, or `users/{user}`; a leading `@` is accepted and stripped). **Developer Preview** and user
  auth only.
- `google_chat_list_memberships` — members of one space, optional `role` and `memberType`, paged.
- `google_chat_send_message` — sends text, optionally as a thread reply (`threadKey` + `replyOption`);
  uses OAuth user identity when authenticated, otherwise the webhook. A webhook cannot use
  `messageId`.
- `google_chat_edit_message` — updates the `text` field only, with the required `updateMask=text`.
- `google_chat_delete_message` — deletes a message the user owns.

Every listing returns one bounded page and never loops. `google_chat_list_messages` and
`google_chat_search_messages` report the `nextPageToken` for the caller to continue.

## Commands

Alisio namespaces external plugin commands as `plugin-id:command-name`, so the registered commands are:

```
/google-chat:auth     # run the loopback OAuth user authorization flow
/google-chat:status   # show configured modes and what each can do (no secrets)
```

`status` reports the active mode, whether the webhook and OAuth client are configured, whether tokens
are stored, and the capability matrix, without ever printing a token, code, secret, or webhook URL.

## Safety and privacy

- **Fixed destinations only.** Requests go to `https://chat.googleapis.com` and
  `https://oauth2.googleapis.com`; the browser authorization URL is opened by you, never fetched by the
  plugin. Redirects are refused (`redirect: "error"`), and no proxy, cookies, or user agent override
  are used.
- **Validated webhook.** The single user-supplied destination must be an HTTPS
  `https://chat.googleapis.com/v1/spaces/{space}/messages` URL with `key` and `token`, no credentials,
  no fragment, and no unexpected query parameters.
- **Bounded transport.** The host `AbortSignal` is combined with a hard timeout, the response body is
  streamed with a 1 MiB cap, and the reader is cancelled on overflow.
- **Honest rate limiting.** `429`/`5xx` on reads are retried at most twice with truncated exponential
  backoff, honouring `Retry-After` when present. Mutations are never retried blindly; they surface the
  bounded `Retry-After` hint.
- **Closed failure vocabulary.** Failures collapse to: invalid input, not authenticated, not
  permitted, not found, rate limited, temporarily unavailable, invalid response, response exceeded
  limit, and configuration missing or invalid. `403 PERMISSION_DENIED` is mapped before existence,
  because Google Chat returns it for inaccessible resources without confirming whether they exist.
- **Untrusted content.** Every result that carries remote content opens with a provenance boundary,
  normalizes control characters, neutralizes Markdown, caps each field, and clamps the aggregate with a
  deterministic truncation marker.

The plugin also ships the `gchat-context` skill, which teaches an agent to fetch Chat context for
standups, incidents, and threads, to prefer reads, to confirm before sending or editing, never to paste
secrets into messages, and to treat message content as untrusted.

## Requirements

Node.js **>= 22.16** and an Alisio host with `@alisio/sdk` `>=0.1.0-alpha.10`. Zero runtime
dependencies: only Node built-ins (`node:http`, `node:fs`, `node:crypto`, `node:os`, `node:path`) and
native `fetch`.

## License

MIT.
