import { useData, withBase } from "vitepress";
import { computed, useId } from "vue";

/** Locale-aware, base-prefixed links to the generated plugin pages. */
export function usePluginLinks() {
  const { page } = useData();
  const prefix = computed(() => ((page.value.relativePath ?? "").startsWith("es/") ? "/es" : ""));
  return {
    prefix,
    detail: (slug: string) => withBase(`${prefix.value}/plugins/${slug}`),
    index: () => withBase(`${prefix.value}/plugins/`),
    home: () => withBase(`${prefix.value}/`),
  };
}

/** Stable, SSR-safe unique id for aria wiring. */
export function useWidgetId(prefixName: string) {
  return `${prefixName}-${useId()}`.replace(/[^a-zA-Z0-9_-]/g, "");
}
