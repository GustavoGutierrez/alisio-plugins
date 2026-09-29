<script setup lang="ts">
import { useData } from "vitepress";
import { computed } from "vue";
import { type PluginEntry, pluginBySlug } from "../data";
import { categoryLabel, formatBytes, formatCount, formatDate } from "../format";
import { usePluginLinks } from "../paths";

const props = defineProps<{ slug: string }>();

const { lang } = useData();
const links = usePluginLinks();
const plugin = computed<PluginEntry | undefined>(() => pluginBySlug(props.slug));
const spanish = computed(() => lang.value === "es");

const text = computed(() => ({
  back: spanish.value ? "Volver al catálogo" : "Back to the catalog",
  missing: spanish.value
    ? "Este plugin ya no está en el catálogo."
    : "This plugin is no longer in the catalog.",
  details: spanish.value ? "Detalles" : "Details",
  install: spanish.value ? "Instalación" : "Install",
  metadata: spanish.value ? "Metadatos" : "Metadata",
  npm: "npm",
  repository: spanish.value ? "Repositorio" : "Repository",
  homepage: spanish.value ? "Sitio" : "Homepage",
  report: spanish.value ? "Reportar un problema" : "Report an issue",
  securityTitle: spanish.value ? "Nota de seguridad" : "Security note",
  security: spanish.value
    ? "Los plugins se ejecutan en proceso con tus privilegios de usuario y no están en un sandbox. Revisa el código fuente antes de instalar un plugin de terceros."
    : "Plugins run in-process with your user privileges and are not sandboxed. Review the source before installing a third-party plugin.",
  rows: {
    package: spanish.value ? "Paquete" : "Package",
    version: spanish.value ? "Versión" : "Version",
    published: spanish.value ? "Publicado" : "Published",
    author: spanish.value ? "Autor" : "Author",
    maintainers: spanish.value ? "Mantenedores" : "Maintainers",
    license: spanish.value ? "Licencia" : "License",
    categories: spanish.value ? "Categorías" : "Categories",
    size: spanish.value ? "Tamaño" : "Size",
    dependencies: spanish.value ? "Dependencias" : "Dependencies",
    peers: spanish.value ? "Peer dependencies" : "Peer dependencies",
    downloads: spanish.value ? "Descargas (último mes)" : "Downloads (last month)",
    source: spanish.value ? "Origen" : "Source",
    keywords: spanish.value ? "Palabras clave" : "Keywords",
  },
}));

const sourceLabel = computed(() => {
  if (!plugin.value) return "";
  if (plugin.value.source === "local") return spanish.value ? "Primera parte" : "First-party";
  return spanish.value ? "Terceros" : "Third-party";
});

const rows = computed<Array<{ label: string; value: string; code?: boolean }>>(() => {
  const entry = plugin.value;
  if (!entry) return [];
  const labels = text.value.rows;
  const add = (label: string, value: string | null | undefined, code = false) =>
    value ? { label, value, code } : null;
  const list: Array<{ label: string; value: string; code?: boolean }> = [];
  const push = (...items: Array<{ label: string; value: string; code?: boolean } | null>) => {
    for (const item of items) if (item) list.push(item);
  };
  push(
    add(labels.package, entry.name, true),
    add(labels.version, entry.version),
    add(labels.published, entry.publishedAt ? formatDate(entry.publishedAt, lang.value) : null),
    add(labels.author, entry.author),
    add(
      labels.maintainers,
      entry.maintainers.filter((person) => person !== entry.author).join(", ") || null,
    ),
    add(labels.license, entry.license),
    add(
      labels.categories,
      entry.categories.map((category) => categoryLabel(category, lang.value)).join(", "),
    ),
    add(labels.size, entry.unpackedSize === null ? null : formatBytes(entry.unpackedSize)),
    add(labels.dependencies, String(entry.dependencyCount)),
    add(labels.peers, String(entry.peerCount)),
    add(labels.downloads, formatCount(entry.downloadsLastMonth, lang.value)),
    add(labels.source, sourceLabel.value),
    add(labels.keywords, entry.keywords.join(", ")),
  );
  return list;
});
</script>

<template>
  <div class="plugin-detail">
    <p v-if="!plugin" class="catalog-empty">
      <a class="back-link" :href="links.index()">← {{ text.back }}</a><br />
      {{ text.missing }}
    </p>

    <template v-else>
      <a class="back-link" :href="links.index()">← {{ text.back }}</a>
      <h1>{{ plugin.title }}</h1>
      <p>{{ plugin.description }}</p>

      <div class="detail-header">
        <strong>{{ text.details }}:</strong>
        <PluginBadges
          :categories="plugin.categories"
          :source="plugin.source"
          :featured="plugin.featured"
        />
      </div>
      <div class="detail-links">
        <a :href="plugin.npmUrl" target="_blank" rel="noopener noreferrer">{{ text.npm }}</a>
        <a
          v-if="plugin.repository"
          :href="plugin.repository"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ text.repository }}
        </a>
        <a
          v-if="plugin.homepage"
          :href="plugin.homepage"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ text.homepage }}
        </a>
        <a
          v-if="plugin.bugs || plugin.repository"
          :href="plugin.bugs ?? `${plugin.repository}/issues`"
          target="_blank"
          rel="noopener noreferrer"
        >
          {{ text.report }}
        </a>
      </div>

      <div class="detail-cover">
        <PluginCover
          :src="plugin.cover"
          loading="eager"
          :alt="lang === 'es' ? `Portada de ${plugin.title}` : `${plugin.title} cover`"
        />
      </div>

      <h2>{{ text.install }}</h2>
      <InstallCommand :package="plugin.installName" :version="plugin.version" />

      <h2>{{ text.metadata }}</h2>
      <table class="plugin-meta-table">
        <tbody>
          <tr v-for="row in rows" :key="row.label">
            <th scope="row">{{ row.label }}</th>
            <td>
              <code v-if="row.code">{{ row.value }}</code>
              <template v-else>{{ row.value }}</template>
            </td>
          </tr>
        </tbody>
      </table>

      <aside class="plugin-security">
        <strong>{{ text.securityTitle }}:</strong> {{ text.security }}
      </aside>
    </template>
  </div>
</template>
