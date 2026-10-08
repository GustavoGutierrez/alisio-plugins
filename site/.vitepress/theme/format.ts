/** Presentation helpers for the catalog. No dependencies, locale-aware. */

const CATEGORY_LABELS: Record<string, { en: string; es: string }> = {
  "model-provider": { en: "Model provider", es: "Proveedor de modelos" },
  "methodology-harness": { en: "Methodology harness", es: "Arnés de metodología" },
  memory: { en: "Memory", es: "Memoria" },
  subagents: { en: "Subagents", es: "Subagentes" },
  search: { en: "Search", es: "Búsqueda" },
  tools: { en: "Tools", es: "Herramientas" },
  security: { en: "Security", es: "Seguridad" },
  analytics: { en: "Analytics", es: "Analítica" },
  mcp: { en: "MCP", es: "MCP" },
  storage: { en: "Storage", es: "Almacenamiento" },
  ui: { en: "UI", es: "Interfaz" },
  "icon-theme": { en: "Icon theme", es: "Tema de iconos" },
  decisions: { en: "Decisions", es: "Decisiones" },
};

/** Human label for a category id, falling back to the id itself. */
export function categoryLabel(category: string, lang = "en"): string {
  const labels = CATEGORY_LABELS[category];
  if (!labels) return category;
  return lang === "es" ? labels.es : labels.en;
}

const RELATIVE_UNITS = [
  { seconds: 60, en: (v: number) => `${v}m`, es: (v: number) => `${v} min` },
  { seconds: 3600, en: (v: number) => `${v}h`, es: (v: number) => `${v} h` },
  { seconds: 86400, en: (v: number) => `${v}d`, es: (v: number) => `${v} d` },
  { seconds: 2592000, en: (v: number) => `${v}d`, es: (v: number) => `${v} d` },
];

/** Relative time such as "28m ago" / "hace 28 min". */
export function relativeTime(iso: string, now: number, lang = "en"): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return lang === "es" ? "ahora mismo" : "just now";
  const spanish = lang === "es";
  const suffix = spanish ? "hace" : "ago";
  const label = (unit: { en: (v: number) => string; es: (v: number) => string }, value: number) =>
    spanish ? unit.es(value) : unit.en(value);
  if (seconds < 60) return spanish ? `${suffix} <1 min` : `<1m ${suffix}`;
  for (let index = 0; index < RELATIVE_UNITS.length; index += 1) {
    const unit = RELATIVE_UNITS[index];
    if (seconds < unit.seconds) {
      // `unit` is the first threshold the elapsed time does NOT reach, so the value belongs to the
      // previous scale: minutes below an hour, hours below a day, days below a month.
      const scale = index === 0 ? unit : RELATIVE_UNITS[index - 1];
      const value = Math.floor(seconds / scale.seconds);
      return spanish ? `${suffix} ${label(scale, value)}` : `${label(scale, value)} ${suffix}`;
    }
  }
  const months = Math.floor(seconds / 2592000);
  if (months < 12)
    return spanish
      ? `${suffix} ${months} ${months === 1 ? "mes" : "meses"}`
      : `${months}mo ${suffix}`;
  const years = Math.floor(months / 12);
  return spanish ? `${suffix} ${years} ${years === 1 ? "año" : "años"}` : `${years}y ${suffix}`;
}

/** Absolute date for `title`/fallback text. */
export function formatDate(iso: string, lang = "en"): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!parts) return iso;
  const date = new Date(`${parts[1]}-${parts[2]}-${parts[3]}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === "es" ? "es" : "en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** Human byte size such as "42.3 kB". */
export function formatBytes(size: number | null): string {
  if (size === null || !Number.isFinite(size)) return "—";
  if (size < 1024) return `${size} B`;
  const units = ["kB", "MB", "GB"];
  let value = size / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

/** Group-separated integer. */
export function formatCount(value: number | null, lang = "en"): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(lang === "es" ? "es" : "en").format(value);
}
