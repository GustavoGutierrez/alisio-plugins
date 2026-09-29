<script setup lang="ts">
import { useData } from "vitepress";
import { computed } from "vue";
import { categoryLabel } from "../format";

const props = withDefaults(
  defineProps<{
    categories: string[];
    source?: "local" | "third-party" | null;
    featured?: boolean;
  }>(),
  { source: null, featured: false },
);

const { lang } = useData();
const labels = computed(() =>
  props.categories.map((category) => categoryLabel(category, lang.value)),
);
const sourceLabel = computed(() => {
  if (props.source === "local") return lang.value === "es" ? "Mantenido aquí" : "First-party";
  if (props.source === "third-party") return lang.value === "es" ? "De terceros" : "Third-party";
  return null;
});
</script>

<template>
  <div class="plugin-badges">
    <span v-if="props.featured" class="plugin-badge plugin-badge--featured">
      ★ {{ lang === "es" ? "Destacado" : "Featured" }}
    </span>
    <span
      v-for="category in props.categories"
      :key="category"
      class="plugin-badge"
      :class="`plugin-badge--${category}`"
    >
      {{ categoryLabel(category, lang) }}
    </span>
    <span v-if="sourceLabel" class="plugin-badge plugin-badge--source">{{ sourceLabel }}</span>
  </div>
</template>
