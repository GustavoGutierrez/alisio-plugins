// Plain-language command texts (en/es). The app frame localizes its own strings from codes.
import type { SetupResult } from "./engine/setup.js";

export type Locale = "en" | "es";

export const megabytes = (bytes: number) => Math.max(1, Math.round(bytes / 1_000_000));

const MIN = "0.11.7";

const en = {
  unknownModel:
    "Setup failed: unknown_model. options.model must be one of e5-small, e5-base, minilm.",
  help: {
    withApp:
      "Open Notebook from the Apps group in the project sidebar: create a notebook, add files from your computer or the workspace, and ask questions answered only from them, with citations. Run /semantic:setup once to enable semantic search (a one-time model download); without it the Notebook uses keyword search.",
    withoutApp: `This Alisio host has no plugin apps API, so the Notebook app is unavailable: it needs Alisio ${MIN} or newer. /semantic:setup and /semantic:status still work.`,
  },
  status: {
    noApi: `This Alisio host has no semantic API (needs Alisio ${MIN} or newer): providers are not registered and the Notebook uses keyword search only.`,
    available: (embedding: string, store: string) =>
      `Semantic search: available (embedding ${embedding}, store ${store}).`,
    unavailable:
      "Semantic search: not available; the Notebook uses keyword search only. Run /semantic:setup.",
    activeModel: (id: string, dims: number) => `Active model: ${id} (${dims} dimensions).`,
    unknownModel: "Configured model: unknown_model (options.model is not in the model table).",
    model: (label: string, prepared: boolean, bytes: number) =>
      `Model: ${label}, ${prepared ? "downloaded and verified" : `not downloaded (one-time download of about ${megabytes(bytes)} MB)`}.`,
    health: { ready: "ready", starting: "starting", unavailable: "unavailable" } as Record<
      string,
      string
    >,
    embedder: (state: string) => `Embedding provider semantic.e5: ${state}.`,
    store: (state: string) => `Vector store semantic.lance: ${state}.`,
    notebooks: (n: number | null) => (n === null ? "Notebooks: unavailable." : `Notebooks: ${n}.`),
    disk: (models: number, lance: number) =>
      `Disk use: model cache ${megabytes(models)} MB, vector store ${megabytes(lance)} MB.`,
  },
  downloadNotice: (bytes: number) =>
    `Semantic search needs a one-time download of about ${megabytes(bytes)} MB. After that it works offline.`,
  model: (label: string, destination: string) => `Model: ${label}. Destination: ${destination}.`,
  progress: (percent: number, done: number, total: number) =>
    `Downloading… ${percent}% (${megabytes(done)} of ${megabytes(total)} MB)`,
  doneNotice:
    "The search engine and model are downloaded and verified. They will not be downloaded again; semantic search now works offline.",
  alreadyPrepared:
    "The search engine and model are already downloaded and verified; nothing to download.",
  cancelled: "Setup cancelled. No partial file was kept; run /semantic:setup to start again.",
  nothingToCancel: "No setup is running.",
  failed: (code: string) =>
    code === "model_corrupt"
      ? "A downloaded file did not match its pinned checksum (or was not a safe archive) and was deleted. Nothing was activated; run /semantic:setup to try again."
      : code === "download_failed"
        ? "The model could not be downloaded (network or server error). Nothing was activated; run /semantic:setup to try again."
        : code === "engine_unavailable"
          ? "The local search engine is not available for this system (supported: Linux x64/arm64, macOS on Apple silicon, Windows x64/arm64). The Notebook keeps working with keyword search."
          : `Setup failed (${code}). Nothing was activated.`,
  activation: {
    activated:
      "Semantic search is active: Alisio now uses this plugin's local model and vector store.",
    already_active: "Semantic search was already active with this plugin; nothing changed.",
    other_provider_active: (active: string) =>
      `Another semantic provider is configured (${active}); it was left unchanged. Change semantic.embedding and semantic.store in your global Alisio configuration to switch.`,
    declined:
      "You declined activation; nothing changed. Run /semantic:setup again when you want it.",
    needs_confirmation:
      'Alisio could not ask for confirmation here (no interactive surface). Run /semantic:setup in the TUI or the web app, or set semantic.embedding = "semantic.e5" and semantic.store = "semantic.lance" in your global configuration.',
    disabled:
      "Semantic search is disabled in your Alisio configuration (semantic.enabled = false); nothing changed.",
    unavailable: (message?: string) =>
      `Alisio could not activate the providers${message ? `: ${message}` : ""}. Nothing changed.`,
    no_semantic_api:
      "This Alisio host has no semantic API (it needs Alisio 0.11.7 or newer). The model is ready, and the Notebook keeps working with keyword search only.",
    activate_unsupported:
      'This Alisio host cannot activate providers from a plugin. Set semantic.embedding = "semantic.e5" and semantic.store = "semantic.lance" in your global configuration.',
  },
};

type Messages = typeof en;

const es: Messages = {
  unknownModel:
    "La preparación falló: unknown_model. options.model debe ser e5-small, e5-base o minilm.",
  help: {
    withApp:
      "Abre Cuaderno desde el grupo Aplicaciones del panel de proyectos: crea un cuaderno, añade archivos de tu equipo o del espacio de trabajo y haz preguntas que se responden solo con ellos, con citas. Ejecuta /semantic:setup una vez para activar la búsqueda semántica (una descarga única del modelo); sin ella el Cuaderno usa búsqueda por palabras clave.",
    withoutApp: `Este host de Alisio no tiene la API de apps de plugins, así que la app Cuaderno no está disponible: requiere Alisio ${MIN} o posterior. /semantic:setup y /semantic:status siguen funcionando.`,
  },
  status: {
    noApi: `Este host de Alisio no tiene la API semántica (requiere Alisio ${MIN} o posterior): los proveedores no se registran y el Cuaderno funciona solo con búsqueda por palabras clave.`,
    available: (embedding, store) =>
      `Búsqueda semántica: disponible (embeddings ${embedding}, almacén ${store}).`,
    unavailable:
      "Búsqueda semántica: no disponible; el Cuaderno funciona solo con búsqueda por palabras clave. Ejecuta /semantic:setup.",
    activeModel: (id, dims) => `Modelo activo: ${id} (${dims} dimensiones).`,
    unknownModel:
      "Modelo configurado: unknown_model (options.model no está en la tabla de modelos).",
    model: (label, prepared, bytes) =>
      `Modelo: ${label}, ${prepared ? "descargado y verificado" : `sin descargar (descarga única de unos ${megabytes(bytes)} MB)`}.`,
    health: { ready: "listo", starting: "iniciando", unavailable: "no disponible" },
    embedder: (state) => `Proveedor de embeddings semantic.e5: ${state}.`,
    store: (state) => `Almacén vectorial semantic.lance: ${state}.`,
    notebooks: (n) => (n === null ? "Cuadernos: no disponibles." : `Cuadernos: ${n}.`),
    disk: (models, lance) =>
      `Uso de disco: caché de modelos ${megabytes(models)} MB, almacén vectorial ${megabytes(lance)} MB.`,
  },
  downloadNotice: (bytes) =>
    `La búsqueda semántica necesita una descarga única de unos ${megabytes(bytes)} MB. Después funciona sin conexión.`,
  model: (label, destination) => `Modelo: ${label}. Destino: ${destination}.`,
  progress: (percent, done, total) =>
    `Descargando… ${percent}% (${megabytes(done)} de ${megabytes(total)} MB)`,
  doneNotice:
    "El motor y el modelo de búsqueda están descargados y verificados. No se volverán a descargar; la búsqueda semántica ya funciona sin conexión.",
  alreadyPrepared:
    "El motor y el modelo de búsqueda ya están descargados y verificados; no hay nada que descargar.",
  cancelled:
    "Configuración cancelada. No se conservó ningún archivo parcial; ejecuta /semantic:setup para empezar de nuevo.",
  nothingToCancel: "No hay ninguna configuración en curso.",
  failed: (code) =>
    code === "model_corrupt"
      ? "Un archivo descargado no coincidió con su suma de verificación fijada (o no era un archivo comprimido seguro) y se eliminó. No se activó nada; ejecuta /semantic:setup para reintentar."
      : code === "download_failed"
        ? "No se pudo descargar el modelo (error de red o del servidor). No se activó nada; ejecuta /semantic:setup para reintentar."
        : code === "engine_unavailable"
          ? "El motor de búsqueda local no está disponible para este sistema (compatibles: Linux x64/arm64, macOS con Apple silicon, Windows x64/arm64). El Cuaderno sigue funcionando con búsqueda por palabras clave."
          : `La configuración falló (${code}). No se activó nada.`,
  activation: {
    activated:
      "La búsqueda semántica está activa: Alisio usa ahora el modelo local y el almacén vectorial de este plugin.",
    already_active: "La búsqueda semántica ya estaba activa con este plugin; no cambió nada.",
    other_provider_active: (active) =>
      `Hay otro proveedor semántico configurado (${active}); se dejó sin cambios. Cambia semantic.embedding y semantic.store en tu configuración global de Alisio para usar este.`,
    declined:
      "Rechazaste la activación; no cambió nada. Ejecuta /semantic:setup de nuevo cuando quieras.",
    needs_confirmation:
      'Alisio no pudo pedir confirmación aquí (no hay superficie interactiva). Ejecuta /semantic:setup en la TUI o en la app web, o define semantic.embedding = "semantic.e5" y semantic.store = "semantic.lance" en tu configuración global.',
    disabled:
      "La búsqueda semántica está desactivada en tu configuración de Alisio (semantic.enabled = false); no cambió nada.",
    unavailable: (message) =>
      `Alisio no pudo activar los proveedores${message ? `: ${message}` : ""}. No cambió nada.`,
    no_semantic_api:
      "Este host de Alisio no tiene la API semántica (requiere Alisio 0.11.7 o posterior). El modelo está listo y el Cuaderno sigue funcionando solo con búsqueda por palabras clave.",
    activate_unsupported:
      'Este host de Alisio no puede activar proveedores desde un plugin. Define semantic.embedding = "semantic.e5" y semantic.store = "semantic.lance" en tu configuración global.',
  },
};

/**
 * Command language: `options.locale` when set, else the host process locale (`LC_ALL`,
 * `LC_MESSAGES`, `LANG`), else English. `es*` is Spanish; anything else is English.
 */
export function resolveLocale(option: unknown, env: NodeJS.ProcessEnv = process.env): Locale {
  if (option === "es" || option === "en") return option;
  const host = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return host.toLowerCase().startsWith("es") ? "es" : "en";
}

export const messagesFor = (locale: Locale): Messages => (locale === "es" ? es : en);

/** One plain sentence per activation outcome (§6.1). */
export function activationMessage(locale: Locale, result: SetupResult): string {
  const m = messagesFor(locale).activation;
  switch (result.activation) {
    case "other_provider_active": {
      const active = [result.active?.embedding, result.active?.store].filter(Boolean).join(", ");
      return m.other_provider_active(active || "?");
    }
    case "unavailable":
      return m.unavailable(result.message);
    default:
      return m[result.activation];
  }
}
