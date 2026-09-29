<script setup lang="ts">
import { withBase } from "vitepress";
import { computed, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    src?: string | null;
    alt: string;
    loading?: "lazy" | "eager";
  }>(),
  { src: null, loading: "lazy" },
);

/** Branded Alisio fallback, used when no cover exists or a cover fails to load. */
const FALLBACK = "/assets/covers/default-cover.svg";
const failed = ref(false);

watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);

const resolved = computed(() => withBase(!props.src || failed.value ? FALLBACK : props.src));
</script>

<template>
  <img
    class="plugin-cover"
    :src="resolved"
    :alt="props.alt"
    :loading="props.loading"
    decoding="async"
    @error="failed = true"
  />
</template>
