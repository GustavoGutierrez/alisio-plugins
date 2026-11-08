<script setup lang="ts">
import { withBase } from "vitepress";
import { computed, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    src?: string | null;
    size?: number;
  }>(),
  { src: null, size: 40 },
);

/** Icons are optional and have no fallback: a missing or broken icon renders nothing. */
const failed = ref(false);

watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);

const resolved = computed(() => (props.src && !failed.value ? withBase(props.src) : null));
</script>

<template>
  <!-- Decorative: the plugin name is always rendered next to it. -->
  <img
    v-if="resolved"
    class="plugin-icon"
    :src="resolved"
    alt=""
    :width="props.size"
    :height="props.size"
    loading="lazy"
    decoding="async"
    @error="failed = true"
  />
</template>
