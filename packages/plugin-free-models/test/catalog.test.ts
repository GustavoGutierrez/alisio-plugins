import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, DEFAULT_SERVICE_ID, SERVICES } from "../src/catalog.js";
import { formatKeySteps, missingKeyMessage } from "../src/limits.js";
import { endpoint } from "../src/models.js";

describe("catalog", () => {
  it("has unique ids, https URLs and a default model listed first in its free list", () => {
    const ids = SERVICES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SERVICES) {
      expect(s.id).toMatch(/^[a-z0-9-]+$/);
      expect(new URL(s.baseURL).protocol).toBe("https:");
      expect(new URL(s.keyUrl).protocol).toBe("https:");
      expect(s.freeModels.length).toBeGreaterThan(0);
      expect(s.freeModels.map((m) => m.id)).toContain(s.defaultModel);
      expect(new Set(s.freeModels.map((m) => m.id)).size).toBe(s.freeModels.length);
      if (s.listing === "pattern") expect(s.modelPattern).toBeInstanceOf(RegExp);
    }
  });

  it("defaults to keyless Kilo Code with kilo-auto/free ahead of openrouter/free", () => {
    expect(SERVICES[0]?.id).toBe(DEFAULT_SERVICE_ID);
    const kilo = SERVICES.find((s) => s.id === "kilo");
    expect(kilo?.needsKey).toBe(false);
    expect(kilo?.defaultModel).toBe("kilo-auto/free");
    expect(DEFAULT_MODEL).toBe("kilo-auto/free");
    const order = kilo?.freeModels.map((m) => m.id) ?? [];
    expect(order.indexOf("kilo-auto/free")).toBeLessThan(order.indexOf("openrouter/free"));
  });

  it("gives every key-required service key steps that open its https key page", () => {
    for (const s of SERVICES.filter((x) => x.needsKey)) {
      expect(s.keySteps?.en.length).toBeGreaterThanOrEqual(2);
      expect(s.keySteps?.en.length).toBe(s.keySteps?.es.length);
      expect(s.keySteps?.en[0]).toContain(s.keyUrl);
      expect(s.keySteps?.es[0]).toContain(s.keyUrl);
      expect(missingKeyMessage(s)).toContain(s.keyUrl);
      expect(formatKeySteps(s, "es")).toMatch(/necesita una clave gratuita/);
    }
  });

  it("builds endpoints from the exact base URL with no doubled slash or injected /v1", () => {
    expect(endpoint("https://api.kilo.ai/api/gateway", "chat/completions")).toBe(
      "https://api.kilo.ai/api/gateway/chat/completions",
    );
    expect(endpoint("https://generativelanguage.googleapis.com/v1beta/openai/", "models")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai/models",
    );
    for (const s of SERVICES)
      for (const path of ["chat/completions", "models"] as const) {
        const url = endpoint(s.baseURL, path);
        const base = s.baseURL.replace(/\/$/, "");
        expect(url).toBe(`${base}/${path}`);
        expect(url.slice("https://".length)).not.toContain("//");
        expect(url.split("/v1/").length).toBeLessThanOrEqual(2);
        if (!s.baseURL.includes("/v1")) expect(url).not.toContain("/v1/");
      }
  });
});
