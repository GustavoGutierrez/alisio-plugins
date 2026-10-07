<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

/**
 * The closing section of the landing page: the install call to action over the Alisio background
 * image, followed by the remaining reference cards.
 *
 * The scroll reveal is armed on the client only, and skipped entirely when the visitor asks for
 * reduced motion, so the copy is never left hidden behind a script that did not run.
 */
const root = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | undefined;

onMounted(() => {
  const element = root.value;
  if (element === null || typeof IntersectionObserver === "undefined") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  element.classList.add("is-armed");
  observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      element.classList.add("is-visible");
      observer?.disconnect();
      observer = undefined;
    },
    { threshold: 0.12 },
  );
  observer.observe(element);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = undefined;
});
</script>

<template>
  <section ref="root" class="home-closing">
    <div class="home-closing__inner">
      <slot />
    </div>
  </section>
</template>
