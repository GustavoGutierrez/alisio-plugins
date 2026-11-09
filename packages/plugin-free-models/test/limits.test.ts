import { describe, expect, it } from "vitest";
import { SERVICES } from "../src/catalog.js";
import {
  formatLimits,
  formatNotes,
  formatOption,
  formatService,
  resolveLocale,
} from "../src/limits.js";

const ACRONYMS = /\b(?:RPM|RPD|RPH|TPD|TPM|RPS|TPS)\b/;

describe("limits formatter", () => {
  it("writes limits in plain English and Spanish words", () => {
    const limits = { requestsPerMinute: 20, requestsPerDay: 50, scope: "shared" as const };
    expect(formatLimits(limits, "en")).toBe(
      "20 requests per minute, 50 requests per day (shared across all free models)",
    );
    expect(formatLimits(limits, "es")).toBe(
      "20 peticiones por minuto, 50 peticiones por día (compartido entre todos los modelos gratis)",
    );
    expect(formatLimits({ requestsPerHour: 200, scope: "per-ip" }, "es")).toBe(
      "200 peticiones por hora (por dirección IP)",
    );
    expect(formatLimits({ concurrentRequests: 1 }, "es")).toBe("1 petición simultánea");
    expect(formatLimits({ tokensPerMonth: 1_000_000, approximate: true }, "en")).toBe(
      "about 1,000,000 tokens per month",
    );
    expect(formatLimits({ requestsPerSecond: 1, tokensPerDay: 20_000 }, "es")).toBe(
      "1 petición por segundo, 20.000 tokens por día",
    );
    expect(formatLimits({ requestsPerMinute: 2, concurrentRequests: 3 }, "es")).toBe(
      "2 peticiones por minuto, 3 peticiones simultáneas",
    );
    expect(formatLimits({}, "en")).toBe("no published limits");
    expect(formatLimits({ requestsPerMinute: -1 }, "es")).toBe("sin límites publicados");
  });

  it("never prints rate acronyms for any cataloged service, in either language", () => {
    for (const s of SERVICES)
      for (const locale of ["en", "es"] as const) {
        const text = [
          formatLimits(s.limits, locale),
          formatNotes(s.notes, locale),
          formatOption(s, locale),
          formatService(s, locale),
        ].join("\n");
        expect(text).not.toMatch(ACRONYMS);
        expect(text).not.toMatch(/undefined|NaN/);
      }
  });

  it("marks keyless services and links key pages in the help summary", () => {
    const kilo = SERVICES.find((s) => s.id === "kilo");
    const groq = SERVICES.find((s) => s.id === "groq");
    if (!kilo || !groq) throw new Error("missing catalog entries");
    expect(formatOption(kilo)).toBe(
      "Kilo Code — no key needed — 200 requests per hour (per IP address)",
    );
    expect(formatService(groq, "en")).toContain("https://console.groq.com/keys");
    expect(formatService(groq, "es")).toContain("Groq necesita una clave gratuita");
  });

  it("resolves the locale from the argument, then the environment", () => {
    expect(resolveLocale("es", {})).toBe("es");
    expect(resolveLocale(undefined, { LANG: "es_CO.UTF-8" })).toBe("es");
    expect(resolveLocale(undefined, { LANG: "en_US.UTF-8" })).toBe("en");
    expect(resolveLocale(undefined, {})).toBe("en");
  });
});
