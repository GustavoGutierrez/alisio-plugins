<script setup lang="ts">
import { useData } from "vitepress";
import type { PluginEntry } from "../data";
import { usePluginLinks } from "../paths";

const props = defineProps<{ plugin: PluginEntry }>();

const { lang } = useData();
const links = usePluginLinks();
</script>

<template>
  <article class="plugin-card">
    <a class="plugin-card__cover" :href="links.detail(props.plugin.slug)">
      <PluginCover
        :src="props.plugin.cover"
        :alt="lang === 'es' ? `Portada de ${props.plugin.title}` : `${props.plugin.title} cover`"
      />
    </a>
    <div class="plugin-card__body">
      <div>
        <h3 class="plugin-card__title">
          <a :href="links.detail(props.plugin.slug)">{{ props.plugin.title }}</a>
        </h3>
        <code class="plugin-card__package">{{ props.plugin.name }}</code>
      </div>
      <p class="plugin-card__description">{{ props.plugin.description }}</p>
      <PluginBadges
        :categories="props.plugin.categories"
        :source="props.plugin.source"
        :featured="props.plugin.featured"
      />
      <div class="plugin-card__footer">
        <div class="plugin-meta">
          <span>{{ props.plugin.author }}</span>
          <template v-if="props.plugin.version">
            <span aria-hidden="true">·</span>
            <span>v{{ props.plugin.version }}</span>
          </template>
          <template v-if="props.plugin.publishedAt">
            <span aria-hidden="true">·</span>
            <RelativeTime :iso="props.plugin.publishedAt" />
          </template>
        </div>
        <InstallCommand
          :package="props.plugin.installName"
          :version="props.plugin.version"
          compact
        />
        <div class="plugin-card__links">
          <a :href="props.plugin.npmUrl" target="_blank" rel="noopener noreferrer">npm</a>
          <a
            v-if="props.plugin.repository"
            :href="props.plugin.repository"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ lang === "es" ? "Repositorio" : "Repository" }}
          </a>
          <a
            v-if="props.plugin.homepage"
            :href="props.plugin.homepage"
            target="_blank"
            rel="noopener noreferrer"
          >
            {{ lang === "es" ? "Sitio" : "Homepage" }}
          </a>
        </div>
      </div>
    </div>
  </article>
</template>
