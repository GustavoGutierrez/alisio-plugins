<script setup lang="ts">
import { useData } from "vitepress";
import { computed, onMounted, ref } from "vue";
import { formatDate, relativeTime } from "../format";

const props = defineProps<{ iso?: string | null }>();

const { lang } = useData();
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});

const absolute = computed(() => (props.iso ? formatDate(props.iso, lang.value) : ""));
const relative = computed(() => (props.iso ? relativeTime(props.iso, Date.now(), lang.value) : ""));
</script>

<template>
  <span v-if="props.iso" class="plugin-time">
    <time v-if="mounted" :datetime="props.iso" :title="absolute">{{ relative }}</time>
    <time v-else :datetime="props.iso" :title="absolute">{{ absolute }}</time>
  </span>
</template>
