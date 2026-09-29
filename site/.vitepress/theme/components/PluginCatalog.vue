<script setup lang="ts">
import { useData } from "vitepress";
import { computed, ref, watch } from "vue";
import categoryData from "../../data/categories.json";
import { plugins } from "../data";
import { categoryLabel } from "../format";

const { lang } = useData();
const CATEGORIES: string[] = categoryData.categories;

type SortKey = "recent" | "az" | "newest";

/** Client-side page size: keeps the first paint small as the catalog grows. */
const PAGE_SIZE = 24;

const query = ref("");
const category = ref("all");
const sort = ref<SortKey>("recent");
const page = ref(1);

const spanish = computed(() => lang.value === "es");

const text = computed(() => ({
  filterLabel: spanish.value ? "Filtrar plugins" : "Filter plugins",
  filterPlaceholder: spanish.value
    ? "Filtrar plugins por nombre, descripción o categoría"
    : "Filter plugins by name, description, or category",
  categoryLabel: spanish.value ? "Categoría" : "Category",
  sortLabel: spanish.value ? "Ordenar" : "Sort",
  all: spanish.value ? "Todas" : "All",
  search: spanish.value ? "Buscar" : "Search",
  reset: spanish.value ? "Restablecer" : "Reset",
  empty: spanish.value
    ? "Ningún plugin coincide con este filtro."
    : "No plugins match this filter.",
  showing: spanish.value ? "Mostrando" : "Showing",
  of: spanish.value ? "de" : "of",
  pluginsWord: spanish.value ? "plugins" : "plugins",
  sectionTitle: spanish.value ? "Todos los plugins" : "All plugins",
  paginationLabel: spanish.value ? "Paginación" : "Pagination",
  previous: spanish.value ? "Página anterior" : "Previous page",
  next: spanish.value ? "Página siguiente" : "Next page",
  pageWord: spanish.value ? "Página" : "Page",
}));

const sortOptions = computed<Array<{ value: SortKey; label: string }>>(() => [
  {
    value: "recent",
    label: spanish.value ? "Publicados más recientemente" : "Most recently published",
  },
  { value: "az", label: "A\u2013Z" },
  { value: "newest", label: spanish.value ? "Más nuevos primero" : "Newest first" },
]);

function time(value: string | null): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const matches = plugins.filter((plugin) => {
    if (category.value !== "all" && !plugin.categories.includes(category.value)) return false;
    if (!needle) return true;
    return [plugin.name, plugin.title, plugin.description, ...plugin.categories, ...plugin.keywords]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
  const sorted = [...matches];
  if (sort.value === "az") sorted.sort((a, b) => a.title.localeCompare(b.title, lang.value));
  else if (sort.value === "newest")
    sorted.sort(
      (a, b) =>
        time(b.firstPublishedAt ?? b.publishedAt) - time(a.firstPublishedAt ?? a.publishedAt),
    );
  else sorted.sort((a, b) => time(b.publishedAt) - time(a.publishedAt));
  return sorted;
});

const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / PAGE_SIZE)));

/** Only the current page of cards is mounted; the rest never render. */
const paged = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE;
  return filtered.value.slice(start, start + PAGE_SIZE);
});

const rangeStart = computed(() =>
  filtered.value.length === 0 ? 0 : (page.value - 1) * PAGE_SIZE + 1,
);
const rangeEnd = computed(() => Math.min(page.value * PAGE_SIZE, filtered.value.length));

// A new filter, category or sort always starts the list over at page one.
watch([query, category, sort], () => {
  page.value = 1;
});

// Keep the page in range if the result set shrinks for any other reason.
watch(pageCount, (count) => {
  if (page.value > count) page.value = count;
});

function go(next: number): void {
  const clamped = Math.min(Math.max(1, next), pageCount.value);
  if (clamped === page.value) return;
  page.value = clamped;
  if (typeof document !== "undefined")
    document.querySelector("#all-plugins")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function reset(): void {
  query.value = "";
  category.value = "all";
  sort.value = "recent";
}
</script>

<template>
  <section id="all-plugins" class="catalog-section">
    <h2>{{ text.sectionTitle }}</h2>
    <form class="catalog-controls" role="search" @submit.prevent>
      <div class="catalog-field">
        <label for="plugin-filter">{{ text.filterLabel }}</label>
        <input
          id="plugin-filter"
          v-model="query"
          type="search"
          autocomplete="off"
          :placeholder="text.filterPlaceholder"
        />
      </div>
      <div class="catalog-field">
        <label for="plugin-category">{{ text.categoryLabel }}</label>
        <select id="plugin-category" v-model="category">
          <option value="all">{{ text.all }}</option>
          <option v-for="item in CATEGORIES" :key="item" :value="item">
            {{ categoryLabel(item, lang) }}
          </option>
        </select>
      </div>
      <div class="catalog-field">
        <label for="plugin-sort">{{ text.sortLabel }}</label>
        <select id="plugin-sort" v-model="sort">
          <option v-for="option in sortOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </div>
      <div class="catalog-actions">
        <button type="submit">{{ text.search }}</button>
        <button type="button" class="secondary" @click="reset">{{ text.reset }}</button>
      </div>
    </form>

    <p v-if="filtered.length > 0" class="catalog-count" role="status" aria-live="polite">
      {{ text.showing }} {{ rangeStart }}–{{ rangeEnd }} {{ text.of }} {{ filtered.length }}
      {{ text.pluginsWord }}.
    </p>

    <div v-if="paged.length > 0" class="plugin-grid">
      <PluginCard v-for="plugin in paged" :key="plugin.slug" :plugin="plugin" />
    </div>
    <p v-else class="catalog-empty" role="status" aria-live="polite">{{ text.empty }}</p>

    <nav
      v-if="filtered.length > 0 && pageCount > 1"
      class="catalog-pagination"
      :aria-label="text.paginationLabel"
    >
      <button
        type="button"
        class="catalog-pagination__step"
        :disabled="page <= 1"
        :aria-label="text.previous"
        @click="go(page - 1)"
      >
        <span aria-hidden="true">←</span> {{ text.previous }}
      </button>
      <span class="catalog-pagination__status" aria-live="polite">
        {{ text.pageWord }} {{ page }} {{ text.of }} {{ pageCount }}
      </span>
      <button
        type="button"
        class="catalog-pagination__step"
        :disabled="page >= pageCount"
        :aria-label="text.next"
        @click="go(page + 1)"
      >
        {{ text.next }} <span aria-hidden="true">→</span>
      </button>
    </nav>
  </section>
</template>
