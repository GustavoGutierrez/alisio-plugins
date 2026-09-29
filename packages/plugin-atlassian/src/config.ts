import { AtlassianError } from "./errors.js";

/**
 * The installed Alisio SDK exposes no tool-level configuration or secret API, so
 * this plugin reads its settings from the process environment only. Credentials
 * are never accepted through tool input, written to disk, logged, or serialized.
 */
export const ENV = {
  baseUrl: "ATLASSIAN_BASE_URL",
  domain: "ATLASSIAN_DOMAIN",
  email: "ATLASSIAN_EMAIL",
  apiToken: "ATLASSIAN_API_TOKEN",
  allowWrites: "ATLASSIAN_ALLOW_WRITES",
} as const;

export interface AtlassianConfig {
  /** HTTPS origin with no trailing slash or path, e.g. `https://team.atlassian.net`. */
  readonly baseUrl: string;
  /** Lowercase hostname, e.g. `team.atlassian.net`. */
  readonly host: string;
  /** Account email used for HTTP Basic. Non-enumerable so it never serializes. */
  readonly email: string;
  /** API token. Non-enumerable so it never serializes or prints via `util.inspect`. */
  readonly apiToken: string;
  /** True only when `ATLASSIAN_ALLOW_WRITES` is exactly `1`. */
  readonly allowWrites: boolean;
}

export type Environment = Record<string, string | undefined>;

/** A single site label plus the mandatory `.atlassian.net` suffix. */
const DOMAIN_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+atlassian\.net$/;
const WRITES_TRUTHY = "1";

function fail(detail: string): never {
  throw new AtlassianError("configuration missing or invalid", detail);
}

function readTrimmed(env: Environment, key: string): string | undefined {
  const raw = env[key];
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  return value === "" ? undefined : value;
}

function requireValue(env: Environment, key: string): string {
  const value = readTrimmed(env, key);
  if (value === undefined) fail(`${key} is required but was not set`);
  return value;
}

/** Strict truthy parser: only the literal `1` enables writes. */
export function isWritesEnabled(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() === WRITES_TRUTHY;
}

/** Validate and normalize a full base URL. HTTPS, Atlassian host, no noise. */
export function parseBaseUrl(raw: string): { baseUrl: string; host: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("ATLASSIAN_BASE_URL is not a valid absolute URL");
  }
  if (url.protocol !== "https:") fail("ATLASSIAN_BASE_URL must use https");
  if (url.username !== "" || url.password !== "")
    fail("ATLASSIAN_BASE_URL must not embed credentials");
  if (url.port !== "") fail("ATLASSIAN_BASE_URL must not include a port");
  if (url.search !== "") fail("ATLASSIAN_BASE_URL must not include a query string");
  if (url.hash !== "") fail("ATLASSIAN_BASE_URL must not include a fragment");
  if (url.pathname !== "/" && url.pathname !== "")
    fail("ATLASSIAN_BASE_URL must not include a path");
  const host = url.hostname.toLowerCase();
  if (!DOMAIN_PATTERN.test(host)) fail("ATLASSIAN_BASE_URL host must end with .atlassian.net");
  return { baseUrl: `https://${host}`, host };
}

/** Validate a bare host such as `team.atlassian.net` and derive the base URL. */
export function parseDomain(raw: string): { baseUrl: string; host: string } {
  const host = raw.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(host)) fail("ATLASSIAN_DOMAIN must be a *.atlassian.net host");
  return { baseUrl: `https://${host}`, host };
}

/**
 * Resolve the full configuration from the environment. Throws a configuration
 * error when anything is missing, partial, conflicting, or malformed. The token
 * and email are attached as non-enumerable properties so `JSON.stringify` and
 * `util.inspect` never reveal them.
 */
export function loadConfig(env: Environment = process.env): AtlassianConfig {
  const baseUrlRaw = readTrimmed(env, ENV.baseUrl);
  const domainRaw = readTrimmed(env, ENV.domain);
  if (baseUrlRaw !== undefined && domainRaw !== undefined)
    fail(`set exactly one of ${ENV.baseUrl} or ${ENV.domain}, not both`);
  if (baseUrlRaw === undefined && domainRaw === undefined)
    fail(`set ${ENV.baseUrl} or ${ENV.domain}`);

  const { baseUrl, host } =
    baseUrlRaw !== undefined ? parseBaseUrl(baseUrlRaw) : parseDomain(domainRaw as string);

  const email = requireValue(env, ENV.email);
  const apiToken = requireValue(env, ENV.apiToken);

  const config = {
    baseUrl,
    host,
    allowWrites: isWritesEnabled(env[ENV.allowWrites]),
  } as unknown as AtlassianConfig;

  Object.defineProperties(config, {
    email: { value: email, enumerable: false, writable: false, configurable: false },
    apiToken: { value: apiToken, enumerable: false, writable: false, configurable: false },
  });

  return Object.freeze(config);
}
