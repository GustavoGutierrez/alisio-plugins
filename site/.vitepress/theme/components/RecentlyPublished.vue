<script setup lang="ts">
import { useData } from "vitepress";
import { computed } from "vue";
import { plugins } from "../data";
import { usePluginLinks } from "../paths";

const props = withDefaults(defineProps<{ limit?: number; title?: string | null }>(), {
  limit: 3,
  title: null,
});

const { lang } = useData();
const links = usePluginLinks();

const newest = computed(() =>
  [...plugins]
    .filter((plugin) => plugin.publishedAt)
    .sort((a, b) => Date.parse(b.publishedAt ?? "") - Date.parse(a.publishedAt ?? ""))
    .slice(0, props.limit),
);

const heading = computed(
  () => props.title ?? (lang.value === "es" ? "Publicados recientemente" : "Recently published"),
);
</script>

<template>
  <section v-if="newest.length > 0" id="recently-published" class="catalog-section">
    <h2>{{ heading }}</h2>
    <ul class="recent-list">
      <li v-for="plugin in newest" :key="plugin.slug" class="recent-item">
        <a class="recent-item__cover" :href="links.detail(plugin.slug)">
          <PluginCover
            :src="plugin.cover"
            :alt="lang === 'es' ? `Portada de ${plugin.title}` : `${plugin.title} cover`"
          />
        </a>
        <div class="recent-item__body">
          <h3 class="recent-item__title">
            <a :href="links.detail(plugin.slug)">{{ plugin.title }}</a>
          </h3>
          <div class="plugin-meta">
            <span v-if="plugin.version">v{{ plugin.version }}</span>
            <template v-if="plugin.publishedAt">
              <span aria-hidden="true">·</span>
              <RelativeTime :iso="plugin.publishedAt" />
            </template>
          </div>
          <p class="recent-item__description">{{ plugin.description }}</p>
          <PluginBadges :categories="plugin.categories" :featured="plugin.featured" />
        </div>
      </li>
    </ul>
  </section>
</template>
