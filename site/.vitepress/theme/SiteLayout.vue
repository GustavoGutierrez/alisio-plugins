<script setup lang="ts">
import DefaultTheme from "vitepress/theme";
import HeroVideo from "./components/HeroVideo.vue";

const { Layout } = DefaultTheme;
</script>

<template>
  <Layout>
    <!--
      The default hero exposes no full-bleed slot, so the background video is rendered through the
      hero info slot and positioned over the whole hero from catalog.css.
    -->
    <template #home-hero-info-before>
      <HeroVideo />
    </template>
  </Layout>
</template>
