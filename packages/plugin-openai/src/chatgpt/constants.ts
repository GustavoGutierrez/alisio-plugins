/**
 * Sign in with ChatGPT (SIWC) endpoints and parameters. They live only in this package
 * (spec 025 O4): there is no borrowed client id and no private ChatGPT backend.
 */
export const AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
/** Public OpenAI API base used for inference and models with the SIWC bearer. */
export const API_BASE_URL = "https://api.openai.com/v1";
export const RESOURCE = API_BASE_URL;
/** Dynamic agent registration: the redirect returns the account-specific client id. */
export const DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const AGENT_NAME = "Alisio";
export const SCOPE =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/** SIWC only allows a 127.0.0.1 loopback redirect; a random port is not verified (spec 025 D2). */
export const CALLBACK_PORT = 1455;
export const CALLBACK_PATH = "/auth/callback";
export const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
