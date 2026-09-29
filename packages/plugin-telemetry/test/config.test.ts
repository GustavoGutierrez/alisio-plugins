import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createDefaultConfig,
  describeConfig,
  loadTelemetryConfig,
  OTLP_TOKEN_ENV,
  parseEndpoint,
  resolveTelemetryPaths,
  writeConfigFile,
} from "../src/config.js";
import { makeTempDir } from "./helpers.js";

const SECRET = `s3cr3t-${"v".repeat(20)}`;

function paths(dir: string) {
  return {
    configFile: `${dir}/telemetry/config.json`,
    database: `${dir}/telemetry/telemetry.sqlite`,
  };
}

describe("configuration resolution", () => {
  it("uses safe, privacy-first defaults", () => {
    const result = loadTelemetryConfig({ env: {}, paths: paths("/nonexistent") });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.otlp.enabled).toBe(false);
    expect(result.config.capture).toEqual({
      prompts: false,
      completions: false,
      toolArguments: false,
      toolResults: false,
    });
    expect(result.config.redaction.mode).toBe("strict");
    expect(result.config.retentionDays).toBe(30);
  });

  it("resolves the database and config paths from the documented homes", () => {
    const resolved = resolveTelemetryPaths({
      HOME: "/base",
      ALISIO_CONFIG_HOME: "/cfg",
      ALISIO_STATE_HOME: "/state",
    });
    expect(resolved.configFile).toBe("/cfg/telemetry/config.json");
    expect(resolved.database).toBe("/state/telemetry/telemetry.sqlite");

    const xdg = resolveTelemetryPaths({
      HOME: "/base",
      XDG_CONFIG_HOME: "/xdgc",
      XDG_STATE_HOME: "/xdgs",
    });
    expect(xdg.configFile).toBe("/xdgc/alisio/telemetry/config.json");
    expect(xdg.database).toBe("/xdgs/alisio/telemetry/telemetry.sqlite");

    const explicit = resolveTelemetryPaths({
      HOME: "/base",
      ALISIO_TELEMETRY_DB: "/data/t.sqlite",
    });
    expect(explicit.database).toBe("/data/t.sqlite");
  });

  it("applies file, then environment, then explicit overrides", () => {
    const result = loadTelemetryConfig({
      env: { ALISIO_TELEMETRY_RETENTION_DAYS: "7" },
      paths: paths("/nonexistent"),
      file: { retentionDays: 5, otlp: { serviceName: "from-file" } },
      overrides: { retentionDays: 9 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.retentionDays).toBe(9);
    expect(result.config.otlp.serviceName).toBe("from-file");
  });

  it("lets the environment override the file", () => {
    const result = loadTelemetryConfig({
      env: { ALISIO_TELEMETRY_RETENTION_DAYS: "7", ALISIO_TELEMETRY_OTLP_ENABLED: "true" },
      paths: paths("/nonexistent"),
      file: { retentionDays: 5, otlp: { enabled: false } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.retentionDays).toBe(7);
    expect(result.config.otlp.enabled).toBe(true);
  });

  it("fails closed with an actionable message on invalid values", () => {
    const invalid = loadTelemetryConfig({
      env: {},
      paths: paths("/nonexistent"),
      file: { otlp: { samplingRatio: 2 } },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error).toContain("samplingRatio");

    const unknown = loadTelemetryConfig({
      env: {},
      paths: paths("/nonexistent"),
      file: { mystery: true },
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toContain("unknown field");

    const badEnv = loadTelemetryConfig({
      env: { ALISIO_TELEMETRY_CAPTURE_PROMPTS: "maybe" },
      paths: paths("/nonexistent"),
    });
    expect(badEnv.ok).toBe(false);
  });
});

describe("credential safety", () => {
  it("rejects secret-shaped config keys entirely", () => {
    const result = loadTelemetryConfig({
      env: {},
      paths: paths("/nonexistent"),
      file: { otlp: { token: SECRET } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("never persisted");
      expect(result.error).not.toContain(SECRET);
    }
  });

  it("refuses credential-shaped and embedded-credential headers", () => {
    const header = loadTelemetryConfig({
      env: {},
      paths: paths("/nonexistent"),
      file: { otlp: { headers: { authorization: "value" } } },
    });
    expect(header.ok).toBe(false);
    const endpoint = loadTelemetryConfig({
      env: {},
      paths: paths("/nonexistent"),
      file: { otlp: { endpoint: "https://user:pass@collector.example.com" } },
    });
    expect(endpoint.ok).toBe(false);
    expect(() => parseEndpoint("ftp://collector.example.com")).toThrow();
  });

  it("never persists, logs, returns or serializes the OTLP token", () => {
    const result = loadTelemetryConfig({
      env: { [OTLP_TOKEN_ENV]: SECRET },
      paths: paths("/nonexistent"),
      file: {
        otlp: {
          enabled: true,
          endpoint: "https://collector.example.com",
          tokenEnv: OTLP_TOKEN_ENV,
        },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.config)).not.toContain(SECRET);
    const described = describeConfig(result.config, { [OTLP_TOKEN_ENV]: SECRET });
    expect(JSON.stringify(described)).not.toContain(SECRET);
    expect((described.otlp as { tokenConfigured: boolean }).tokenConfigured).toBe(true);
    const absent = describeConfig(result.config, {});
    expect((absent.otlp as { tokenConfigured: boolean }).tokenConfigured).toBe(false);
  });
});

describe("config file persistence", () => {
  it("writes atomically with 0600 file and 0700 parent and no temp leftovers", () => {
    const temp = makeTempDir();
    try {
      const target = paths(temp.dir).configFile;
      const config = createDefaultConfig();
      config.retentionDays = 14;
      writeConfigFile(target, config);

      expect(readFileSync(target, "utf8")).toContain('"retentionDays": 14');
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(statSync(`${temp.dir}/telemetry`).mode & 0o777).toBe(0o700);
      const leftovers = readdirSync(`${temp.dir}/telemetry`).filter((name) =>
        name.includes(".tmp"),
      );
      expect(leftovers).toEqual([]);
      expect(existsSync(target)).toBe(true);
    } finally {
      temp.cleanup();
    }
  });

  it("round-trips through disk with the token still absent", () => {
    const temp = makeTempDir();
    try {
      const file = paths(temp.dir).configFile;
      const config = createDefaultConfig();
      config.otlp.enabled = true;
      config.otlp.endpoint = "https://collector.example.com";
      writeConfigFile(file, config);
      const reloaded = loadTelemetryConfig({
        env: { [OTLP_TOKEN_ENV]: SECRET },
        paths: paths(temp.dir),
      });
      expect(reloaded.ok).toBe(true);
      expect(readFileSync(file, "utf8")).not.toContain(SECRET);
    } finally {
      temp.cleanup();
    }
  });
});
