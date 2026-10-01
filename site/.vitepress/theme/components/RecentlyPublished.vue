<script setup lang="ts">
import { useData } from "vitepress";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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

/** Slug of the card flipped by a tap; hover and focus flip cards with CSS alone. */
const flipped = ref<string | null>(null);

/**
 * The front is deliberately not a link: VitePress's router intercepts link clicks in the capture
 * phase, so a tap could never flip the card first. Navigation lives on the back face, which hover,
 * keyboard focus (focus-within) or a tap reveals.
 */
function toggle(slug: string) {
  flipped.value = flipped.value === slug ? null : slug;
}

/** A tap anywhere outside the flipped card flips it back. */
function closeOnOutsideTap(event: Event) {
  if (flipped.value && !(event.target as Element | null)?.closest?.(".recent-card.is-flipped"))
    flipped.value = null;
}
onMounted(() => document.addEventListener("pointerdown", closeOnOutsideTap));
onBeforeUnmount(() => document.removeEventListener("pointerdown", closeOnOutsideTap));

const heading = computed(
  () => props.title ?? (lang.value === "es" ? "Publicados recientemente" : "Recently published"),
);
</script>

<template>
  <section v-if="newest.length > 0" id="recently-published" class="catalog-section">
    <h2>{{ heading }}</h2>
    <ul class="recent-list">
      <li
        v-for="plugin in newest"
        :key="plugin.slug"
        class="recent-card"
        :class="{ 'is-flipped': flipped === plugin.slug }"
      >
        <div class="recent-card__inner">
          <!-- Front: cover only, with a blurred footer carrying the name and a little meta. -->
          <div class="recent-card__face recent-card__front" @click="toggle(plugin.slug)">
            <PluginCover
              :src="plugin.cover"
              :alt="lang === 'es' ? `Portada de ${plugin.title}` : `${plugin.title} cover`"
            />
            <span class="recent-card__footer">
              <span class="recent-card__name">{{ plugin.title }}</span>
              <span class="recent-card__meta">
                <span v-if="plugin.version">v{{ plugin.version }}</span>
                <template v-if="plugin.publishedAt">
                  <span aria-hidden="true">·</span>
                  <RelativeTime :iso="plugin.publishedAt" />
                </template>
              </span>
            </span>
          </div>
          <!-- Back: the full detail, shown on hover, keyboard focus or tap. -->
          <div class="recent-card__face recent-card__back">
            <h3 class="recent-card__title">
              <a :href="links.detail(plugin.slug)">{{ plugin.title }}</a>
            </h3>
            <div class="plugin-meta">
              <span v-if="plugin.version">v{{ plugin.version }}</span>
              <template v-if="plugin.publishedAt">
                <span aria-hidden="true">·</span>
                <RelativeTime :iso="plugin.publishedAt" />
              </template>
            </div>
            <p class="recent-card__description">{{ plugin.description }}</p>
            <PluginBadges :categories="plugin.categories" :featured="plugin.featured" />
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>
