import type { FreeLimits, FreeService, LimitScope, NoteId } from "./catalog.js";

export type Locale = "en" | "es";

type RateKey = Exclude<keyof FreeLimits, "approximate" | "scope">;

/** Display order and plain-language units (singular, plural); never abbreviations. */
const UNITS: ReadonlyArray<[RateKey, Record<Locale, [string, string]>]> = [
  [
    "requestsPerSecond",
    {
      en: ["request per second", "requests per second"],
      es: ["petición por segundo", "peticiones por segundo"],
    },
  ],
  [
    "requestsPerMinute",
    {
      en: ["request per minute", "requests per minute"],
      es: ["petición por minuto", "peticiones por minuto"],
    },
  ],
  [
    "requestsPerHour",
    {
      en: ["request per hour", "requests per hour"],
      es: ["petición por hora", "peticiones por hora"],
    },
  ],
  [
    "requestsPerDay",
    { en: ["request per day", "requests per day"], es: ["petición por día", "peticiones por día"] },
  ],
  [
    "requestsPerMonth",
    {
      en: ["request per month", "requests per month"],
      es: ["petición por mes", "peticiones por mes"],
    },
  ],
  [
    "tokensPerMinute",
    {
      en: ["token per minute", "tokens per minute"],
      es: ["token por minuto", "tokens por minuto"],
    },
  ],
  [
    "tokensPerDay",
    { en: ["token per day", "tokens per day"], es: ["token por día", "tokens por día"] },
  ],
  [
    "tokensPerMonth",
    { en: ["token per month", "tokens per month"], es: ["token por mes", "tokens por mes"] },
  ],
  [
    "concurrentRequests",
    {
      en: ["concurrent request", "concurrent requests"],
      es: ["petición simultánea", "peticiones simultáneas"],
    },
  ],
];

const SCOPES: Record<LimitScope, Record<Locale, string>> = {
  "per-ip": { en: "per IP address", es: "por dirección IP" },
  "per-model": { en: "per model", es: "por modelo" },
  "per-ip-per-model": { en: "per IP address and per model", es: "por dirección IP y por modelo" },
  shared: { en: "shared across all free models", es: "compartido entre todos los modelos gratis" },
  "per-account": { en: "per account", es: "por cuenta" },
};

const NOTES: Record<NoteId, Record<Locale, string>> = {
  "no-account": { en: "no account or key needed", es: "no necesita cuenta ni clave" },
  "no-credit-card": { en: "no credit card needed", es: "no necesita tarjeta de crédito" },
  "prompts-may-be-logged": {
    en: "free providers may log your prompts",
    es: "los proveedores gratuitos pueden registrar tus mensajes",
  },
  "prompts-may-train": {
    en: "free-tier prompts may be used to improve or train models",
    es: "los mensajes del plan gratuito pueden usarse para mejorar o entrenar modelos",
  },
  "non-commercial": { en: "non-commercial use only", es: "solo para uso no comercial" },
  "phone-verification": {
    en: "sign-up needs phone verification",
    es: "el registro requiere verificar un teléfono",
  },
  "developer-program": {
    en: "needs a free NVIDIA Developer Program membership",
    es: "requiere la membresía gratuita del NVIDIA Developer Program",
  },
  "eu-hosted": { en: "hosted in the European Union", es: "alojado en la Unión Europea" },
  roleplay: {
    en: "specialized in roleplay and storytelling",
    es: "especializado en rol y narrativa",
  },
  "limits-unpublished": {
    en: "the provider does not publish exact free limits",
    es: "el proveedor no publica los límites gratuitos exactos",
  },
  "router-picks-model": {
    en: "kilo-auto/free picks a free model for each request",
    es: "kilo-auto/free elige un modelo gratis en cada petición",
  },
  "key-ignored": {
    en: "used anonymously; the key field is ignored",
    es: "se usa de forma anónima; el campo de clave se ignora",
  },
};

const TEXT = {
  noLimits: { en: "no published limits", es: "sin límites publicados" },
  about: { en: "about", es: "aproximadamente" },
  freeLimits: { en: "Free limits", es: "Límites gratuitos" },
  notes: { en: "Notes", es: "Notas" },
  noKey: { en: "no key needed", es: "no necesita clave" },
  models: { en: "Free models", es: "Modelos gratis" },
} satisfies Record<string, Record<Locale, string>>;

const number = (value: number, locale: Locale) =>
  new Intl.NumberFormat(locale === "es" ? "es-ES" : "en-US", { useGrouping: true }).format(value);

/** "20 requests per minute, 50 requests per day (shared across all free models)". */
export function formatLimits(limits: FreeLimits, locale: Locale = "en"): string {
  const parts = UNITS.flatMap(([key, unit]) => {
    const value = limits[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return [];
    return [`${number(value, locale)} ${unit[locale][value === 1 ? 0 : 1]}`];
  });
  if (!parts.length) return TEXT.noLimits[locale];
  const prefix = limits.approximate ? `${TEXT.about[locale]} ` : "";
  const scope = limits.scope ? ` (${SCOPES[limits.scope][locale]})` : "";
  return `${prefix}${parts.join(", ")}${scope}`;
}

export function formatNotes(notes: readonly NoteId[], locale: Locale = "en"): string {
  return notes.map((note) => NOTES[note][locale]).join("; ");
}

/** One line for a select option: "Groq — needs a free key — 30 requests per minute, ...". */
export function formatOption(service: FreeService, locale: Locale = "en"): string {
  const access = service.needsKey
    ? { en: "needs a free key", es: "necesita una clave gratuita" }[locale]
    : TEXT.noKey[locale];
  return `${service.name} — ${access} — ${formatLimits(service.limits, locale)}`;
}

/** A multi-line summary of one service for help output. */
export function formatService(service: FreeService, locale: Locale = "en"): string {
  const access = service.needsKey ? formatKeySteps(service, locale) : TEXT.noKey[locale];
  const lines = [
    `${service.name} (${service.id}): ${access}`,
    `  ${TEXT.freeLimits[locale]}: ${formatLimits(service.limits, locale)}`,
  ];
  if (service.notes.length)
    lines.push(`  ${TEXT.notes[locale]}: ${formatNotes(service.notes, locale)}`);
  lines.push(`  ${TEXT.models[locale]}: ${service.freeModels.map((m) => m.id).join(", ")}`);
  return lines.join("\n");
}

/** Picks Spanish when the argument or the environment asks for it. */
export function resolveLocale(
  arg: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Locale {
  if (arg === "es" || arg === "en") return arg;
  const lang = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return /^es\b|^es[_-]/i.test(lang) ? "es" : "en";
}

/** Plain steps to get a free key: "Groq needs a free key. 1) Open <url> and sign in. ...". */
export function keyStepList(service: FreeService, locale: Locale = "en"): string[] {
  const steps = service.keySteps?.[locale] ?? [
    locale === "es"
      ? `Abre ${service.keyUrl} e inicia sesión.`
      : `Open ${service.keyUrl} and sign in.`,
    locale === "es" ? "Crea una clave y cópiala." : "Create a key and copy it.",
  ];
  return [
    ...steps,
    locale === "es"
      ? "Pégala en el campo Clave de la conexión."
      : "Paste it in the Key field of the connection.",
  ];
}

export function formatKeySteps(service: FreeService, locale: Locale = "en"): string {
  const head =
    locale === "es"
      ? `${service.name} necesita una clave gratuita.`
      : `${service.name} needs a free key.`;
  const steps = keyStepList(service, locale).map((step, index) => `${index + 1}) ${step}`);
  return [head, ...steps].join(" ");
}

/** Bilingual error for a key-required service used without a key. */
export function missingKeyMessage(service: FreeService): string {
  return `${formatKeySteps(service, "en")} / ${formatKeySteps(service, "es")}`;
}
