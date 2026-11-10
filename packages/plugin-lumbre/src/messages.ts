// Plain-language command and tool texts (en/es). The frame localizes its own strings.
export type Locale = "en" | "es";

export const MIN_HOST_TEXT = "0.11.6";

const en = {
  helpWithApp:
    "Open Lumbre from the Apps group of your project: describe the site or app you want, choose a model and a stack, review every change before it is applied, and open the live preview in your browser. Generated code runs on this computer with your permissions after Alisio asks you, so review it before using it.",
  helpWithoutApp: `This Alisio host has no plugin apps API, so the Lumbre studio is unavailable: it needs Alisio ${MIN_HOST_TEXT} or newer. The read-only tool lumbre_projects still lists your projects.`,
  noSession: "No active session.",
  noProjects: "No Lumbre projects yet. Open Lumbre from the Apps group to create one.",
};
const es: typeof en = {
  helpWithApp:
    "Abre Lumbre desde el grupo Aplicaciones de tu proyecto: describe el sitio o la aplicación que quieres, elige un modelo y una base, revisa cada cambio antes de aplicarlo y abre la vista previa en vivo en tu navegador. El código generado se ejecuta en este equipo con tus permisos después de que Alisio te lo pida, así que revísalo antes de usarlo.",
  helpWithoutApp: `Esta versión de Alisio no tiene la API de aplicaciones de plugins, así que el estudio de Lumbre no está disponible: necesita Alisio ${MIN_HOST_TEXT} o posterior. La herramienta de solo lectura lumbre_projects sigue listando tus proyectos.`,
  noSession: "No hay una sesión activa.",
  noProjects: "Todavía no hay proyectos de Lumbre. Abre Lumbre desde Aplicaciones para crear uno.",
};

/** `options.locale`, else the system language (LC_ALL, LC_MESSAGES, LANG), else English. */
export function resolveLocale(option: unknown, env: NodeJS.ProcessEnv = process.env): Locale {
  const value =
    (typeof option === "string" && option) || env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return value.toLowerCase().startsWith("es") ? "es" : "en";
}

export const messagesFor = (locale: Locale) => (locale === "es" ? es : en);
