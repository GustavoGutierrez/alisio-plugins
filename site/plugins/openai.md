---
title: "OpenAI"
description: "Official OpenAI Responses API provider"
pageClass: "plugin-detail"
---

<PluginDetail slug="openai" />

Official OpenAI Responses API provider for Alisio. Install with `alisio install npm:@alisio/plugin-openai`.

The plugin registers two providers that share the same Responses client (streaming, function tools, stateless continuation, model discovery, usage reporting, cancellation, and `store: false`). The host must choose an active model; availability is account-specific.

| Provider | Credential | Billing |
|---|---|---|
| `openai` (OpenAI) | OpenAI API key | OpenAI API usage |
| `chatgpt` (ChatGPT Plus/Pro) | Sign in with ChatGPT, no key | Your ChatGPT plan |

Keep them as separate profiles: signing out of `chatgpt` never touches the `openai` key, and the reverse.

## API key (`openai`)

Connect with an OpenAI API key from `/connect`, or export `OPENAI_API_KEY` (a stored key takes precedence). Works with any Alisio core that supports this plugin.

## Sign in with ChatGPT (`chatgpt`)

Uses OpenAI's official Sign in with ChatGPT flow: Alisio registers itself as an agent named "Alisio" in your ChatGPT account, and requests go to the public `https://api.openai.com/v1` API with a short-lived bearer token. The host stores and renews the session; `OPENAI_API_KEY` is never used for this provider.

Requires an Alisio core built on `@alisio/sdk` 0.11 or newer. Older cores do not run the sign-in and report `ChatGPT sign-in requires Alisio >= 0.11`; the `openai` provider keeps working there.

From the web UI:

1. Run `/connect` (or open Settings > Models) and add a **ChatGPT Plus/Pro** profile.
2. Choose **Continue with ChatGPT** and open the sign-in link.
3. Sign in to ChatGPT and approve Alisio.
4. The browser returns to `http://127.0.0.1:1455/auth/callback` and the profile shows as connected.

New ChatGPT profiles preselect `gpt-5.6-terra` (Alisio >= 0.11.1); pick any other model your plan lists.

If the browser cannot reach Alisio (port 1455 is busy, or Alisio runs on another machine without a tunnel), it ends on an error page. Copy that page's full address and paste it into the field Alisio shows; the sign-in completes the same way. The TUI `/connect` offers the same steps.

Remote use is supported only through an SSH tunnel to your own machine: forward the callback port as well as the web port (`ssh -L 1455:127.0.0.1:1455 `), then sign in from your local browser. Copying credentials between machines is not supported.

If you revoke Alisio in your ChatGPT settings, or the session cannot be renewed, the profile asks you to sign in again from `/connect`.

### Preview, eligibility and terms

- Sign in with ChatGPT is an OpenAI **preview**: some API features are unavailable (for example `temperature`, `max_output_tokens`, and hosted tools), and the plugin omits `max_output_tokens` on this provider.
- OpenAI opens plan usage to open-source projects and locally hosted apps such as a self-run Alisio. Commercial or third-party hosted deployments may need OpenAI's approval and are out of scope.
- Usage counts against your ChatGPT plan limits, not API billing, and is subject to OpenAI's terms of use. A ChatGPT plan that is not eligible returns a `subscription_sharing_*` error, shown as such.

## Requirements

Node.js >= 22.16 and `@alisio/sdk` `>=0.9.0 <0.12.0` (sign-in needs 0.11).

## License

MIT.
