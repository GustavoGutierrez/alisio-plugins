import type { PluginAPI } from "@alisio/sdk";
import { describeConfig } from "./config.js";
import { safeMessage } from "./errors.js";
import type { GoogleChatClient } from "./http.js";
import { runLoopbackAuthorization } from "./oauth.js";

/**
 * Commands registered as `auth` and `status`. Alisio namespaces external
 * plugin commands as `<plugin id>:<name>`, so the real invocation forms are
 * `/google-chat:auth` and `/google-chat:status`.
 */
export const COMMAND_NAMES = ["auth", "status"] as const;

const AUTH_USAGE =
  "Google Chat authorization requires OAuth user mode. Set GOOGLE_CHAT_CLIENT_ID and GOOGLE_CHAT_CLIENT_SECRET, then run google-chat:auth again.";

async function authCommand(client: GoogleChatClient): Promise<string> {
  const oauth = client.config.oauth;
  if (oauth === undefined) return AUTH_USAGE;
  let authorizationUrl = "";
  try {
    const result = await runLoopbackAuthorization({
      config: oauth,
      fetcher: client.fetcher,
      timeoutMs: client.config.authTimeoutMs,
      onAuthorizationUrl: (url) => {
        authorizationUrl = url;
      },
    });
    const token = result.token;
    client.tokenStore.write(token);
    return [
      "Open this URL in your browser to authorize Google Chat:",
      authorizationUrl,
      "",
      `Authorized. Tokens were stored at ${oauth.tokenFile} with 0600 permissions.`,
      `Granted scopes: ${token.scopes.join(", ")}`,
    ].join("\n");
  } catch (error) {
    const lines = [`Google Chat authorization failed: ${safeMessage(error)}`];
    if (authorizationUrl !== "")
      lines.push(
        "",
        "If the flow timed out, open this URL again and re-run google-chat:auth:",
        authorizationUrl,
      );
    return lines.join("\n");
  }
}

function statusCommand(client: GoogleChatClient): string {
  const caps = client.capabilities();
  const described = describeConfig(client.config);
  const lines: string[] = [
    "Google Chat configuration:",
    `- Active mode: ${caps.mode}`,
    `- Incoming webhook: ${described.webhookConfigured ? "configured (send-only)" : "not configured"}${
      described.webhookSpace === null ? "" : ` for ${described.webhookSpace}`
    }`,
    `- OAuth client: ${described.oauthClientConfigured ? "configured" : "not configured"}`,
  ];
  if (described.tokenFile !== null) lines.push(`- Token file: ${described.tokenFile}`);

  let authenticated = false;
  if (described.oauthClientConfigured) {
    try {
      const token = client.tokenStore.read();
      if (token === null) {
        lines.push("- OAuth tokens: not stored (run google-chat:auth)");
      } else {
        authenticated = true;
        const expiry =
          token.expiry === undefined ? "unknown" : new Date(token.expiry).toISOString();
        lines.push(`- OAuth tokens: stored, access token expires ${expiry}`);
        if (token.scopes.length > 0) lines.push(`- Granted scopes: ${token.scopes.join(", ")}`);
      }
    } catch (error) {
      lines.push(`- OAuth tokens: unusable (${safeMessage(error)})`);
    }
  }

  const can = (value: boolean): string => (value ? "yes" : "no");
  lines.push(
    "",
    "Capabilities:",
    `- List spaces, messages, and memberships; search messages: ${can(caps.canRead && authenticated)}`,
    `- Send messages: ${can(caps.canSend)}`,
    `- Edit message text: ${can(caps.canEdit && authenticated)}`,
    `- Delete messages: ${can(caps.canDelete && authenticated)}`,
    "",
    "Reading and editing always require OAuth user mode; an incoming webhook can only send.",
  );
  return lines.join("\n");
}

export function registerCommands(api: PluginAPI, client: GoogleChatClient): void {
  api.commands.register("auth", async () => authCommand(client), {
    description: "Authorize a Google user account with a loopback OAuth flow",
    argumentHint: "",
  });
  api.commands.register("status", async () => statusCommand(client), {
    description: "Show which Google Chat modes are configured and what they can do",
    argumentHint: "",
  });
}
